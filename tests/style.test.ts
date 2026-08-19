import { describe, it, expect, vi } from 'vitest';
import { styleSplit, humanDelays, URGENT_MULTIPLIER } from '../src/style/engine';
import { NullTranscriber, WhisperTranscriber, createTranscriber } from '../src/integrations/transcribe';

describe('styleSplit', () => {
  it('splits on ||| and trims parts', () => {
    expect(styleSplit('сейчас гляну ||| по датам вот что ||| если что — я на связи')).toEqual([
      'сейчас гляну',
      'по датам вот что',
      'если что — я на связи',
    ]);
  });

  it('returns a single part when there is no marker', () => {
    expect(styleSplit('Добрый день!')).toEqual(['Добрый день!']);
  });

  it('drops empty parts', () => {
    expect(styleSplit('|||привет||| |||как дела|||')).toEqual(['привет', 'как дела']);
  });

  it('merges the tail into the 3rd part when there are more than 3', () => {
    expect(styleSplit('a|||b|||c|||d|||e')).toEqual(['a', 'b', 'c d e']);
  });

  it('splits a >900-char part at the last sentence boundary before 900', () => {
    const first = 'Первое предложение. '.repeat(43).trim(); // ~860 chars of sentences
    const long = `${first} ${'х'.repeat(200)}.`;
    const parts = styleSplit(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(900);
    expect(parts[0].endsWith('.')).toBe(true);
  });

  it('hard-cuts at 900 when a long part has no sentence boundary', () => {
    const long = 'щ'.repeat(1500);
    const parts = styleSplit(long);
    expect(parts[0]).toHaveLength(900);
    expect(parts[1]).toHaveLength(600);
  });
});

describe('humanDelays', () => {
  it('is deterministic: same input, same delays', () => {
    const parts = ['сейчас гляну', 'по датам вот что: стандарт свободен'];
    expect(humanDelays(parts)).toEqual(humanDelays(parts));
  });

  it('computes the first delay from reply length and guest message length', () => {
    // 400 + 10*15 + 20*5 = 650
    const [first] = humanDelays(['a'.repeat(10)], { guestMsgLength: 20 });
    expect(first).toEqual({ text: 'a'.repeat(10), delayMs: 650 });
  });

  it('clamps the first delay to [400, 1200]', () => {
    expect(humanDelays([''])[0].delayMs).toBe(400);
    expect(humanDelays(['a'.repeat(500)])[0].delayMs).toBe(1200);
  });

  it('computes subsequent delays as clamp(600 + len*20, 600, 2500)', () => {
    const parts = ['x', 'a'.repeat(10), 'b'.repeat(500)];
    const delays = humanDelays(parts);
    expect(delays[1].delayMs).toBe(800); // 600 + 10*20
    expect(delays[2].delayMs).toBe(2500); // clamped
  });

  it('scales with the multiplier and re-clamps to [200, 2500]', () => {
    // first: clamp(400 + 10*15, 400, 1200) = 550; *0.6 = 330
    // second: clamp(600 + 10*20, 600, 2500) = 800; *0.6 = 480
    const delays = humanDelays(['a'.repeat(10), 'b'.repeat(10)], { multiplier: 0.6 });
    expect(delays[0].delayMs).toBe(330);
    expect(delays[1].delayMs).toBe(480);
    // tiny delays re-clamp to the 200 floor
    expect(humanDelays(['', ''], { multiplier: 0.1 })[0].delayMs).toBe(200);
  });

  it('multiplier 0 (urgent) bypasses the clamp: all delays are 0', () => {
    expect(URGENT_MULTIPLIER).toBe(0);
    const delays = humanDelays(['срочно', 'уже занимаюсь'], { multiplier: URGENT_MULTIPLIER });
    expect(delays.map((d) => d.delayMs)).toEqual([0, 0]);
  });
});

describe('transcriber', () => {
  it('NullTranscriber always returns null', async () => {
    const t = new NullTranscriber();
    await expect(t.transcribe(Buffer.from('audio'), 'audio/ogg')).resolves.toBeNull();
  });

  it('createTranscriber picks Whisper with a key, Null without', () => {
    expect(createTranscriber('sk-test')).toBeInstanceOf(WhisperTranscriber);
    expect(createTranscriber()).toBeInstanceOf(NullTranscriber);
    expect(createTranscriber('')).toBeInstanceOf(NullTranscriber);
  });

  it('WhisperTranscriber posts multipart to OpenAI and returns the text', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: 'привет, есть номера на завтра?' }),
    })) as unknown as typeof fetch;
    const t = new WhisperTranscriber('sk-test', fetchFn);

    const result = await t.transcribe(Buffer.from('fake-ogg'), 'audio/ogg; codecs=opus');
    expect(result).toBe('привет, есть номера на завтра?');

    const mock = fetchFn as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    const form = init.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    const file = form.get('file') as File;
    expect(file.name).toBe('audio.ogg'); // file name derived from the mime type
  });

  it('WhisperTranscriber returns null on HTTP error', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: 'bad key' }),
    })) as unknown as typeof fetch;
    const t = new WhisperTranscriber('sk-bad', fetchFn);
    await expect(t.transcribe(Buffer.from('x'), 'audio/mpeg')).resolves.toBeNull();
  });

  it('WhisperTranscriber returns null when fetch throws', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const t = new WhisperTranscriber('sk-test', fetchFn);
    await expect(t.transcribe(Buffer.from('x'), 'audio/ogg')).resolves.toBeNull();
  });
});

describe('ссылки в длинных ответах', () => {
  it('не разрезает ссылку пополам — битый адрес это потерянная бронь', () => {
    const url = 'https://kazzhol.128-140-86-176.sslip.io/b/9RyMZSb_uA_pRJiaBQMJnw';
    // Длинный ответ, где ссылка попадает ровно на границу разреза.
    const long = `${'Отель предлагает удобное расположение и завтрак. '.repeat(19)}${url}`;
    const parts = styleSplit(long);
    // Ссылка обязана целиком лежать ровно в одной части.
    expect(parts.filter((p) => p.includes(url))).toHaveLength(1);
    for (const p of parts) {
      if (!p.includes(url)) expect(p).not.toContain('https://');
    }
  });

  it('короткий ответ со ссылкой не трогает вовсе', () => {
    const text = 'Всё готово: https://example.com/b/abc — нажмите кнопку.';
    expect(styleSplit(text)).toEqual([text]);
  });
});
