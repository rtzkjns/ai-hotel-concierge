/**
 * Turning whatever a hotel has into text the bot can use.
 *
 * A hotel's knowledge does not arrive as tidy web pages. It is a PDF menu, an Excel price
 * list, a Word file of policies, or a photo of the laminated sheet at reception. All of it
 * has to end up as plain text, because that is the only thing a system prompt can carry.
 *
 * Text-based formats are parsed here. PDFs and photographs go to the model itself — it
 * reads them once, at upload, and we store the result. Doing that per guest message would
 * be slow and expensive; doing it once is neither.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { htmlToText, MAX_TEXT_CHARS } from './sourceFetch';
import { readZipText } from './zip';

/** A photo or a scan is only worth reading if the model can see it. */
export const VISION_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
/**
 * Настоящие меню сети весят 14–34 МБ (сканы в PDF), поэтому 12 МБ отсекали ровно те
 * файлы, ради которых загрузка и делалась. Потолок — 32 МБ: столько принимает сам
 * API модели в одном запросе, выше отказ пришёл бы уже от него.
 */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

export interface ExtractResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export interface ExtractDeps {
  client?: Pick<Anthropic, 'messages'>;
  model?: string;
}

/** What the panel offers in the file picker, and what we claim to support. */
export const ACCEPTED_EXTENSIONS = [
  '.pdf', '.docx', '.xlsx', '.csv', '.txt', '.md', '.html', '.htm',
  '.jpg', '.jpeg', '.png', '.webp', '.gif',
];

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

/**
 * Extracts readable text from an uploaded file. Never throws: hotel staff get a sentence
 * they can act on, and one malformed file must not take the request down.
 */
export async function extractText(
  buf: Buffer,
  filename: string,
  deps: ExtractDeps = {},
): Promise<ExtractResult> {
  if (!buf.length) return { ok: false, error: 'Файл пустой' };
  if (buf.length > MAX_UPLOAD_BYTES) {
    const mb = Math.round(buf.length / 1024 / 1024);
    return {
      ok: false,
      error:
        `Файл ${mb} МБ, а панель принимает до 32 МБ. Сожмите PDF или пришлите меню ` +
        'по частям — например, отдельно кухню и отдельно бар.',
    };
  }
  const ext = extensionOf(filename);

  try {
    switch (ext) {
      case '.txt':
      case '.md':
        return finish(buf.toString('utf8'));
      case '.csv':
        return finish(csvToText(buf.toString('utf8')));
      case '.html':
      case '.htm':
        return finish(htmlToText(buf.toString('utf8')));
      case '.docx':
        return finish(docxToText(buf));
      case '.xlsx':
        return finish(xlsxToText(buf));
      case '.pdf':
        return await readWithModel(buf, 'pdf', deps);
      case '.jpg':
      case '.jpeg':
      case '.png':
      case '.webp':
      case '.gif':
        return await readWithModel(buf, mimeForImage(ext), deps);
      default:
        return {
          ok: false,
          error: `Формат ${ext || 'без расширения'} не поддерживается. Подойдут: PDF, Word, Excel, CSV, текст, фото прайса.`,
        };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error && /zip|entry|compression/i.test(err.message)
        ? 'Не удалось открыть файл — возможно, он повреждён или защищён паролем'
        : 'Не удалось прочитать файл',
    };
  }
}

function finish(text: string): ExtractResult {
  const clean = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length < 10) {
    return {
      ok: false,
      error: 'В файле не нашлось текста — возможно, это скан. Пришлите фото страницы, его я прочитаю.',
    };
  }
  return { ok: true, text: clean.slice(0, MAX_TEXT_CHARS) };
}

function mimeForImage(ext: string): string {
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

/** Word stores the body as XML; paragraphs and table cells become lines. */
export function docxToText(buf: Buffer): string {
  const xml = readZipText(buf, 'word/document.xml');
  if (!xml) throw new Error('zip: no word/document.xml');
  return xml
    .replace(/<w:tab\b[^>]*\/?>/g, ' ')
    .replace(/<\/w:(p|tr)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (m, n: string) => {
      const code = Number(n);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Excel keeps most strings in a shared table and references them by index, so a price
 * list read without it comes back as a grid of numbers with no labels.
 */
export function xlsxToText(buf: Buffer): string {
  const shared = readZipText(buf, 'xl/sharedStrings.xml') ?? '';
  const strings = [...shared.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((t) => decodeXml(t[1]))
      .join('')
      .trim(),
  );

  const lines: string[] = [];
  for (let sheet = 1; sheet <= 8; sheet += 1) {
    const xml = readZipText(buf, `xl/worksheets/sheet${sheet}.xml`);
    if (!xml) continue;
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const isShared = /t="s"/.test(cell[1]);
        const isInline = /t="(inlineStr|str)"/.test(cell[1]);
        const raw = /<v>([\s\S]*?)<\/v>/.exec(cell[2])?.[1] ?? '';
        if (isShared) cells.push(strings[Number(raw)] ?? '');
        else if (isInline) {
          cells.push(
            [...cell[2].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join('') ||
              decodeXml(raw),
          );
        } else cells.push(decodeXml(raw));
      }
      const line = cells.filter((c) => c !== '').join(' · ').trim();
      if (line) lines.push(line);
    }
  }
  if (!lines.length) throw new Error('zip: no worksheet rows');
  return lines.join('\n');
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** A comma or semicolon grid reads better to the model as rows of labelled values. */
export function csvToText(raw: string): string {
  const sep = (raw.match(/;/g)?.length ?? 0) > (raw.match(/,/g)?.length ?? 0) ? ';' : ',';
  return raw
    .split(/\r?\n/)
    .map((line) =>
      line
        .split(sep)
        .map((c) => c.replace(/^"|"$/g, '').trim())
        .filter(Boolean)
        .join(' · '),
    )
    .filter(Boolean)
    .join('\n');
}

const READ_PROMPT =
  'Это документ отеля: меню, прайс-лист, правила проживания или подобное. ' +
  'Перепиши ВСЁ его содержимое обычным текстом, сохранив названия, цены, единицы, ' +
  'часы работы и условия точно как в оригинале. Не добавляй ничего от себя, не пересказывай ' +
  'и не сокращай. Если в документе несколько разделов — сохрани их порядок и заголовки. ' +
  'Если это фотография и часть текста не читается — напиши на её месте [неразборчиво]. ' +
  'В ответе — только текст документа, без вступлений и комментариев.';

/**
 * PDFs and photographs are read by the model once, at upload. This is where a photo of the
 * laminated price sheet at reception becomes something the bot can quote to a guest.
 */
async function readWithModel(
  buf: Buffer,
  kind: string,
  deps: ExtractDeps,
): Promise<ExtractResult> {
  if (!deps.client) {
    return { ok: false, error: 'Чтение файлов сейчас недоступно — попробуйте позже' };
  }
  const source =
    kind === 'pdf'
      ? { type: 'base64' as const, media_type: 'application/pdf' as const, data: buf.toString('base64') }
      : { type: 'base64' as const, media_type: kind as 'image/jpeg', data: buf.toString('base64') };

  try {
    const res = await deps.client.messages.create({
      model: deps.model ?? 'claude-sonnet-5',
      max_tokens: 4000,
      messages: [
        {
          role: 'user',
          content: [
            kind === 'pdf'
              ? ({ type: 'document', source } as never)
              : ({ type: 'image', source } as never),
            { type: 'text', text: READ_PROMPT },
          ],
        },
      ],
    });
    const text = (res.content ?? [])
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .trim();
    if (!text) {
      return { ok: false, error: 'В файле не удалось разобрать текст' };
    }
    return finish(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (/too large|exceeds|max_tokens|413/i.test(msg)) {
      return { ok: false, error: 'Файл слишком большой — пришлите его частями' };
    }
    return { ok: false, error: 'Не удалось прочитать файл, попробуйте ещё раз' };
  }
}
