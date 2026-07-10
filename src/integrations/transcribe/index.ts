/**
 * Voice message transcription. Without an OpenAI key the NullTranscriber makes the
 * bot honestly ask for text; with OPENAI_API_KEY set, Whisper transcribes live.
 */

export interface Transcriber {
  transcribe(audio: Buffer, mime: string): Promise<string | null>;
}

/** No transcription key configured: callers send the "please text me" fallback. */
export class NullTranscriber implements Transcriber {
  async transcribe(_audio: Buffer, _mime: string): Promise<string | null> {
    return null;
  }
}

const OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';

const MIME_EXT: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
};

function extForMime(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase();
  // WhatsApp voice notes are ogg/opus, so that's the safest default.
  return MIME_EXT[base] ?? 'ogg';
}

export class WhisperTranscriber implements Transcriber {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async transcribe(audio: Buffer, mime: string): Promise<string | null> {
    try {
      const form = new FormData();
      form.append('model', 'whisper-1');
      const blob = new Blob([new Uint8Array(audio)], { type: mime.split(';')[0].trim() });
      form.append('file', blob, `audio.${extForMime(mime)}`);

      const res = await this.fetchFn(OPENAI_TRANSCRIPTION_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
      });
      if (!res.ok) {
        // Redacted on purpose: status only, never the key or the audio.
        console.warn(`Transcription failed: OpenAI responded ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { text?: unknown };
      return typeof data.text === 'string' ? data.text : null;
    } catch (err) {
      console.warn(
        `Transcription failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      return null;
    }
  }
}

export function createTranscriber(openaiApiKey?: string): Transcriber {
  return openaiApiKey ? new WhisperTranscriber(openaiApiKey) : new NullTranscriber();
}
