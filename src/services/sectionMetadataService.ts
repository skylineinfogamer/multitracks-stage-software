import type { Section, Song } from '../types';

export interface SongSectionsMetadata {
  version: 1;
  songId: string;
  songName: string;
  artist?: string;
  bpm: number;
  key: string;
  beatsPerBar: number;
  firstBeat: number;
  duration: number;
  sections: Section[];
  updatedAt: string;
}

/** Sanitize file name for OS compatibility */
function sanitizeFileName(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'song';
}

/**
 * Serializes the song's musical sections and timing metadata into a lightweight JSON.
 */
export function serializeSections(song: Song): string {
  const meta: SongSectionsMetadata = {
    version: 1,
    songId: song.id,
    songName: song.name,
    artist: song.artist,
    bpm: song.bpm,
    key: song.key,
    beatsPerBar: song.beatsPerBar,
    firstBeat: song.firstBeat,
    duration: song.duration,
    sections: song.sections.map((s) => ({
      id: s.id,
      type: s.type,
      label: s.label,
      start: Number(s.start.toFixed(3)),
      end: Number(s.end.toFixed(3)),
      color: s.color,
    })),
    updatedAt: new Date().toISOString(),
  };

  return JSON.stringify(meta, null, 2);
}

/**
 * Downloads `${song.name}.sections.json` file to the user's computer.
 */
export function exportSectionsJsonFile(song: Song): void {
  const json = serializeSections(song);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeFileName(song.name)}.sections.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Validates and parses a JSON string containing section metadata.
 */
export function parseSectionsJson(raw: string): SongSectionsMetadata {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Conteúdo JSON inválido.');
  }

  if (!Array.isArray(parsed.sections)) {
    throw new Error('O arquivo não contém uma lista válida de seções ("sections").');
  }

  const sections: Section[] = parsed.sections.map((s: any, idx: number) => {
    if (typeof s.start !== 'number' || typeof s.end !== 'number') {
      throw new Error(`Seção #${idx + 1} com tempos inválidos.`);
    }
    return {
      id: s.id || `s-${idx}-${Date.now()}`,
      type: s.type || 'VERSO',
      label: s.label || `Seção ${idx + 1}`,
      start: Math.max(0, s.start),
      end: Math.max(s.start + 0.1, s.end),
      color: s.color,
    };
  });

  return {
    version: 1,
    songId: parsed.songId || '',
    songName: parsed.songName || '',
    artist: parsed.artist,
    bpm: typeof parsed.bpm === 'number' && parsed.bpm > 0 ? parsed.bpm : 120,
    key: parsed.key || 'C',
    beatsPerBar: typeof parsed.beatsPerBar === 'number' && parsed.beatsPerBar > 0 ? parsed.beatsPerBar : 4,
    firstBeat: typeof parsed.firstBeat === 'number' ? parsed.firstBeat : 0,
    duration: typeof parsed.duration === 'number' ? parsed.duration : 0,
    sections,
    updatedAt: parsed.updatedAt || new Date().toISOString(),
  };
}

/**
 * Merges imported metadata into an existing Song object without modifying stems or raw audio files.
 */
export function mergeSectionsIntoSong(song: Song, meta: SongSectionsMetadata): Song {
  return {
    ...song,
    bpm: meta.bpm || song.bpm,
    key: meta.key || song.key,
    beatsPerBar: meta.beatsPerBar || song.beatsPerBar,
    firstBeat: meta.firstBeat ?? song.firstBeat,
    sections: meta.sections.map((s) => ({ ...s })),
  };
}

/**
 * Helper to build Backblaze B2 metadata destination URL for a song.
 */
export function buildB2SectionsUrl(b2BaseUrl: string, songName: string): string {
  const cleanBase = b2BaseUrl.replace(/\/+$/, '');
  const fileName = `${encodeURIComponent(sanitizeFileName(songName))}.sections.json`;
  return `${cleanBase}/${fileName}`;
}

/**
 * Attempts to sync section metadata to Backblaze B2 or cloud storage.
 * If direct upload is not supported by bucket CORS/authorization, provides clean feedback.
 */
export async function syncSectionsToB2(
  b2BaseUrl: string,
  song: Song,
  authToken?: string,
): Promise<{ success: boolean; message: string }> {
  if (!b2BaseUrl || !b2BaseUrl.startsWith('http')) {
    return {
      success: false,
      message: 'URL base do Backblaze B2 não configurada ou inválida.',
    };
  }

  const url = buildB2SectionsUrl(b2BaseUrl, song.name);
  const json = serializeSections(song);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (authToken) {
      headers['Authorization'] = authToken;
    }

    const res = await fetch(url, {
      method: 'PUT',
      headers,
      body: json,
    });

    if (res.ok) {
      return {
        success: true,
        message: `Metadados sincronizados com sucesso no Backblaze B2 (${song.sections.length} seções).`,
      };
    } else {
      // If direct PUT is restricted (e.g. read-only public download bucket), notify gracefully
      return {
        success: false,
        message: `Bucket B2 retornou status ${res.status}. Certifique-se de que a gravação/upload esteja habilitada no bucket.`,
      };
    }
  } catch (err: any) {
    return {
      success: false,
      message: `Não foi possível conectar ao endpoint B2: ${err?.message || 'Erro de rede/CORS'}.`,
    };
  }
}
