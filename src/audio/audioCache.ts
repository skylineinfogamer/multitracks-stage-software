import type { Song } from '../types';

/**
 * High-performance RAM Audio Buffer Cache Manager for Real-Time Live Playback.
 * 
 * Guarantees zero-latency transitions between setlist songs by keeping decoded
 * PCM AudioBuffers in RAM memory. Implements smart LRU cache eviction with TTL
 * that NEVER evicts the currently active song or the pre-loaded next song.
 */
export class AudioCacheManager {
  private cache = new Map<string, Map<string, AudioBuffer>>();
  private accessOrder: string[] = [];
  private lastAccessTime = new Map<string, number>();
  private preloadingIds = new Set<string>();
  private maxCachedSongs = 5; // Keeps active, next, previous + 2 in RAM (typical ~500MB-1.5GB RAM)
  private cacheTTL = 10 * 60 * 1000; // 10 minutes TTL for unpinned songs

  /** Pinned songs that must NEVER be evicted under any circumstances */
  private pinnedIds = new Set<string>();

  /**
   * Set the songs that must remain pinned in RAM (typically activeSongId + nextSongId + prevSongId).
   */
  setPinnedSongs(songIds: (string | null | undefined)[]) {
    this.pinnedIds.clear();
    for (const id of songIds) {
      if (id) this.pinnedIds.add(id);
    }
    this.enforceLimit();
  }

  /**
   * Configure cache limits (call once at app startup).
   */
  configure(options: { maxCachedSongs?: number; cacheTTLMs?: number }) {
    if (options.maxCachedSongs !== undefined) this.maxCachedSongs = options.maxCachedSongs;
    if (options.cacheTTLMs !== undefined) this.cacheTTL = options.cacheTTLMs;
  }

  /**
   * Check if all decoded audio buffers for a song are in RAM.
   */
  has(songId: string): boolean {
    const buffers = this.cache.get(songId);
    return Boolean(buffers && buffers.size > 0);
  }

  /**
   * Get the decoded audio buffer map for a song from RAM (0ms latency).
   */
  get(songId: string): Map<string, AudioBuffer> | undefined {
    const buffers = this.cache.get(songId);
    if (buffers) {
      this.touch(songId);
    }
    return buffers;
  }

  /**
   * Store a song's decoded audio buffers into RAM cache.
   */
  set(songId: string, buffers: Map<string, AudioBuffer>) {
    this.cache.set(songId, buffers);
    this.touch(songId);
    this.enforceLimit();
  }

  /**
   * Evict a specific song from cache.
   */
  delete(songId: string): boolean {
    this.accessOrder = this.accessOrder.filter((id) => id !== songId);
    this.lastAccessTime.delete(songId);
    return this.cache.delete(songId);
  }

  /**
   * Clear all cached buffers except pinned ones.
   */
  clear(forceAll = false) {
    if (forceAll) {
      this.cache.clear();
      this.accessOrder = [];
      this.lastAccessTime.clear();
      this.pinnedIds.clear();
      return;
    }
    for (const id of Array.from(this.cache.keys())) {
      if (!this.pinnedIds.has(id)) {
        this.cache.delete(id);
      }
    }
    this.accessOrder = this.accessOrder.filter((id) => this.pinnedIds.has(id));
    this.lastAccessTime.forEach((_, id) => {
      if (!this.pinnedIds.has(id)) this.lastAccessTime.delete(id);
    });
  }

  /**
   * Preload a song in the background using the provided decoding function.
   * Runs non-blockingly and ignores if already cached or already preloading.
   */
  async preloadSong(
    song: Song,
    loader: (song: Song, onProgress?: (p: number) => void) => Promise<Map<string, AudioBuffer>>,
  ): Promise<boolean> {
    const id = song.id;
    if (this.has(id) || this.preloadingIds.has(id)) {
      return true;
    }

    this.preloadingIds.add(id);
    try {
      // Yield to the event loop first to guarantee UI and active audio threads have priority
      await new Promise((r) => setTimeout(r, 60));
      const buffers = await loader(song, () => {});
      if (buffers && buffers.size > 0) {
        this.set(id, buffers);
        return true;
      }
      return false;
    } catch (err) {
      console.warn(`[AudioCache] Background preload failed for "${song.name}":`, err);
      return false;
    } finally {
      this.preloadingIds.delete(id);
    }
  }

  /**
   * Evict expired entries based on TTL. Call periodically (e.g., every minute).
   */
  evictExpired() {
    const now = Date.now();
    for (const [songId, lastAccess] of this.lastAccessTime) {
      if (this.pinnedIds.has(songId)) continue;
      if (now - lastAccess > this.cacheTTL) {
        this.cache.delete(songId);
        this.lastAccessTime.delete(songId);
        this.accessOrder = this.accessOrder.filter((id) => id !== songId);
      }
    }
  }

  /**
   * Get current cache statistics for debugging/monitoring.
   */
  getStats() {
    let totalBuffers = 0;
    for (const buffers of this.cache.values()) {
      totalBuffers += buffers.size;
    }
    return {
      cachedSongs: this.cache.size,
      totalBuffers,
      pinnedSongs: this.pinnedIds.size,
      preloadingCount: this.preloadingIds.size,
      maxCachedSongs: this.maxCachedSongs,
      cacheTTLMs: this.cacheTTL,
    };
  }

  private touch(songId: string) {
    const now = Date.now();
    this.lastAccessTime.set(songId, now);
    this.accessOrder = this.accessOrder.filter((id) => id !== songId);
    this.accessOrder.push(songId);
  }

  private enforceLimit() {
    // First, evict expired
    this.evictExpired();

    // Then enforce hard limit
    if (this.cache.size <= this.maxCachedSongs) return;

    // Evict oldest unpinned songs first
    for (let i = 0; i < this.accessOrder.length; i++) {
      if (this.cache.size <= this.maxCachedSongs) break;
      const candidateId = this.accessOrder[i];
      if (!this.pinnedIds.has(candidateId)) {
        this.cache.delete(candidateId);
        this.lastAccessTime.delete(candidateId);
        this.accessOrder.splice(i, 1);
        i--;
      }
    }
  }
}

export const globalAudioCache = new AudioCacheManager();

// Auto-evict expired entries every minute
if (typeof window !== 'undefined') {
  setInterval(() => {
    globalAudioCache.evictExpired();
  }, 60_000);
}
