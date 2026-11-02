import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import type {
  BusGroup,
  GuideMode,
  JumpMode,
  LoopMode,
  MidiCuePin,
  MidiMapping,
  PadFolderBank,
  Section,
  SectionType,
  Setlist,
  Song,
  SongTransition,
  Track,
} from './types';
import { AudioEngine } from './audio/engine';
import { PadPlayer, parsePadKeyFromFileName } from './audio/pads';
import { computePeaks, renderClick, renderDemo } from './audio/demo';
import { speakWithGuidePack } from './audio/guideVoices';
import { detectSectionsFromAudio } from './audio/aiAssistant';
import {
  DEFAULT_MIDI_MAPPINGS,
  DEFAULT_SETTINGS,
  type PersistedState,
  type Settings,
  decodeAudioDataSafe,
  deletePadBankStorage,
  deleteStems,
  isValidAudioCandidate,
  loadCustomPadBuffer,
  loadPadBankBuffer,
  loadState,
  loadStemBuffer,
  loadStems,
  savePadBankFile,
  saveState,
} from './storage';
import { TopBar } from './components/TopBar';
import { SetlistStrip } from './components/SetlistStrip';
import { Timeline } from './components/Timeline';
import { SectionGrid } from './components/SectionGrid';
import { Mixer } from './components/Mixer';
import { TransportControls } from './components/TransportControls';
import { FloatingPadWindow, PadPanel } from './components/PadPanel';
import { ImportDialog } from './components/ImportDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { LibraryDrawer } from './components/LibraryDrawer';
import { SongEditDialog } from './components/SongEditDialog';
import { MidiDialog } from './components/MidiDialog';
import { AiAssistantDialog } from './components/AiAssistantDialog';
import { PitchPluginDialog } from './components/PitchPluginDialog';
import { AuthDialog } from './components/AuthDialog';
import { CatalogDialog } from './components/CatalogDialog';
import { AdminPanelDialog } from './components/AdminPanelDialog';
import { RemoteControlDialog } from './components/RemoteControlDialog';
import { SubscriptionGuardModal } from './components/SubscriptionGuardModal';
import { UpdateDialog } from './components/UpdateDialog';
import { WaveformTimelineEditor } from './components/WaveformTimelineEditor';
import { SyncWebModal } from './components/SyncWebModal';
import { useAutoUpdater } from './hooks/useAutoUpdater';
import { remoteControlService } from './services/remoteControlService';
import { authService, type WebPlaylistItem, type WebPlaylist } from './saas/AuthService';
import { masterCatalogService, DEFAULT_B2_BASE_URL } from './saas/MasterCatalogService';
import { subscriptionService } from './saas/SubscriptionService';
import type { CatalogSong, DownloadProgress, User } from './saas/types';
import { KEYS, ensureUtilityTracks, inferTrackBus, isTrackPitched, transposeKey, uid } from './music';
import { isCombinedClickGuide, isDualChannelClickGuide, splitStereoClickGuide } from './audio/audioSeparation';

interface Plan {
  index: number; // target section index
  to: number; // song position to jump to
  boundary: number; // song position where the jump happens
  loop?: boolean;
}

export function sectionIndexAt(song: Song | undefined, pos: number): number {
  if (!song || song.sections.length === 0) return -1;
  let idx = 0;
  song.sections.forEach((s, i) => {
    if (pos >= s.start - 0.001) idx = i;
  });
  return idx;
}

function initialState(): PersistedState {
  const saved = loadState();
  if (saved) {
    // Filter out any legacy demo songs as requested
    const userSongs: Song[] = (saved.songs ?? [])
      .filter((s) => s.source !== 'demo' && !s.id.startsWith('demo-'))
      .map((s) => ({
        ...s,
        pitchOffset: s.pitchOffset ?? 0,
        pitchCents: s.pitchCents ?? 0,
        pitchMode: s.pitchMode ?? 'PRO_SOLA',
        formantPreserve: s.formantPreserve ?? 0.75,
        guideMode: s.guideMode ?? 'REANNOUNCE',
        transitionAfter: s.transitionAfter ?? 'AUTO_ADVANCE',
        tracks: s.tracks.map((t) => {
          const bus = inferTrackBus(t);
          const pitchShift = isTrackPitched({ ...t, bus });
          return {
            ...t,
            bus,
            pitchShift,
            output: t.output ?? (t.kind === 'click' ? 'OUT_6' : t.kind === 'guide' ? 'OUT_5' : 'OUT_1_2'),
          };
        }),
      }))
      .map(ensureUtilityTracks);
    const validIds = new Set(userSongs.map((s) => s.id));
    const cleanedSetlists =
      saved.setlists && saved.setlists.length > 0
        ? saved.setlists.map((sl) => ({
            ...sl,
            songIds: sl.songIds.filter((id) => validIds.has(id)),
          }))
        : [{ id: 'sl-default', name: 'Setlist Principal', songIds: [] }];
    return {
      ...saved,
      songs: userSongs,
      setlists: cleanedSetlists,
      activeSetlistId: cleanedSetlists.some((s) => s.id === saved.activeSetlistId)
        ? saved.activeSetlistId
        : cleanedSetlists[0].id,
      settings: {
        ...DEFAULT_SETTINGS,
        ...saved.settings,
        guideVoicePack: saved.settings?.guideVoicePack ?? 'neural_pt_female',
        guideVoice:
          saved.settings?.guideVoicePack === 'system_native' ? (saved.settings?.guideVoice ?? '') : '',
        midiMappings: saved.settings?.midiMappings ?? DEFAULT_MIDI_MAPPINGS,
      },
    };
  }
  const setlist: Setlist = { id: 'sl-default', name: 'Setlist Principal', songIds: [] };
  return { songs: [], setlists: [setlist], activeSetlistId: setlist.id, settings: DEFAULT_SETTINGS };
}

export default function App() {
  const init = useMemo(initialState, []);
  const [songs, setSongs] = useState<Song[]>(init.songs);
  const [setlists, setSetlists] = useState<Setlist[]>(init.setlists);
  const [activeSetlistId, setActiveSetlistId] = useState(init.activeSetlistId);
  const [settings, setSettings] = useState<Settings>(init.settings);

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loading, setLoading] = useState<{ id: string; progress: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [queued, setQueued] = useState<Plan | null>(null);
  const [loopSectionId, setLoopSectionId] = useState<string | null>(null);
  const [loopMode, setLoopMode] = useState<LoopMode>('infinite');
  const [editMode, setEditMode] = useState(false);
  const [rate, setRate] = useState(1);
  const [bottomTab, setBottomTab] = useState<'mixer' | 'buses' | 'pads'>('mixer');
  const [showChords, setShowChords] = useState(false);
  const [padKey, setPadKey] = useState<string | null>(null);
  const [guideFlash, setGuideFlash] = useState<string | null>(null);
  const [fading, setFading] = useState(false);
  const [dialog, setDialog] = useState<
    | null
    | 'import'
    | 'settings'
    | 'library'
    | 'edit'
    | 'midi'
    | 'ai'
    | 'pitch'
    | 'pads-drawer'
    | 'catalog'
    | 'admin-panel'
    | 'auth'
    | 'remote'
    | 'waveform'
    | 'sync-web'
  >(null);
  const [remoteClientsCount, setRemoteClientsCount] = useState(0);
  const [autonomousClick, setAutonomousClick] = useState<boolean>(() => {
    try {
      return localStorage.getItem('wpp_autonomous_click') === 'true';
    } catch {
      return false;
    }
  });
  const [autonomousBeat, setAutonomousBeat] = useState(1);
  const [user, setUser] = useState<User | null>(() => authService.getCurrentUser());
  const [subscriptionVersion, setSubscriptionVersion] = useState(0);
  const [syncWebPlaylists, setSyncWebPlaylists] = useState<WebPlaylist[]>([]);

  useEffect(() => {
    const unsub = subscriptionService.onSubscriptionUpdate(() => {
      setSubscriptionVersion((v) => v + 1);
    });
    return unsub;
  }, []);

  const accessCheck = useMemo(() => {
    return subscriptionService.checkUserAccess(user);
  }, [user, subscriptionVersion]);
  const [peaksVersion, setPeaksVersion] = useState(0);
  const [midiConnectedCount, setMidiConnectedCount] = useState(0);
  const [midiInFlash, setMidiInFlash] = useState(false);
  const [midiOutFlash, setMidiOutFlash] = useState(false);
  const [hwStats, setHwStats] = useState({
    sampleRate: 48000,
    latencyMs: 2.7,
    maxChannels: 8,
    multichannel: true,
    driverType: 'ASIO' as 'WASAPI' | 'ASIO',
    driverName: 'ASIO4ALL v2',
    bufferSize: 128,
  });

  // Auto-Updater Hook
  const {
    updateAvailable,
    updateInfo,
    isChecking: isCheckingUpdates,
    isDownloading: isDownloadingUpdate,
    downloadProgress: updateProgress,
    downloadStatus: updateStatus,
    error: updateError,
    checkForUpdates,
    downloadAndApply: applyUpdate,
    dismissUpdate,
  } = useAutoUpdater();

  const engineRef = useRef<AudioEngine | null>(null);
  const padRef = useRef<PadPlayer | null>(null);
  if (!engineRef.current) {
    engineRef.current = new AudioEngine();
    padRef.current = new PadPlayer(engineRef.current.ctx);
  }
  const engine = engineRef.current;
  const pads = padRef.current!;

  // Original unshifted decoded stems cache for imported songs (so pitch changes don't re-read IndexedDB)
  const rawImportedRef = useRef(new Map<string, Map<string, AudioBuffer>>());
  const buffersRef = useRef(new Map<string, Map<string, AudioBuffer>>());
  const peaksRef = useRef(new Map<string, Float32Array>());

  const setlist = setlists.find((s) => s.id === activeSetlistId) ?? setlists[0];
  const setlistSongs = (setlist?.songIds ?? []).map((id) => songs.find((s) => s.id === id)).filter(Boolean) as Song[];
  const song = songs.find((s) => s.id === currentId);

  // Restore user-imported Custom Pad folder banks from IndexedDB on startup
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (settings.padBanks && settings.padBanks.length > 0) {
        for (const bank of settings.padBanks) {
          for (const k of bank.keys) {
            if (cancelled) return;
            const ab = await loadPadBankBuffer(bank.id, k);
            if (ab) {
              try {
                const decoded = await decodeAudioDataSafe(engine.ctx, ab);
                pads.setBankBuffer(bank.id, k, decoded);
              } catch {
                /* ignore invalid cached pad */
              }
            }
          }
        }
        if (settings.activePadBankId) {
          pads.setActiveBank(settings.activePadBankId);
        }
      } else {
        // Fallback for legacy single folder
        for (const k of KEYS) {
          if (cancelled) return;
          const ab = await loadCustomPadBuffer(k);
          if (ab) {
            try {
              const decoded = await decodeAudioDataSafe(engine.ctx, ab);
              pads.setCustomBuffer(k, decoded);
            } catch {
              /* ignore invalid cached pad */
            }
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engine, pads, settings.padBanks, settings.activePadBankId]);

  // ------------------------------------------------------------ real hardware telemetry
  useEffect(() => {
    const updateStats = () => setHwStats(engine.getHardwareStats());
    updateStats();
    const id = window.setInterval(updateStats, 2000);
    return () => clearInterval(id);
  }, [engine]);

  // ------------------------------------------------------------ persistence & SaaS profile sync
  useEffect(() => {
    const unsub = authService.onSessionChange((sess) => {
      setUser(sess ? sess.user : null);
    });
    return unsub;
  }, []);

  useEffect(() => {
    saveState({ songs, setlists, activeSetlistId, settings });
  }, [songs, setlists, activeSetlistId, settings]);

  // Silently sync user setlist & mix settings to their SaaS cloud profile
  useEffect(() => {
    if (!user) return;
    const timer = setTimeout(() => {
      authService.saveUserSync(setlists, songs);
    }, 2500);
    return () => clearTimeout(timer);
  }, [user, setlists, songs]);

  useEffect(() => engine.setMasterVolume(settings.masterVolume), [engine, settings.masterVolume]);
  useEffect(() => pads.setVolume(settings.padVolume), [pads, settings.padVolume]);
  useEffect(() => {
    if (pads.sound !== settings.padSound) pads.setSound(settings.padSound);
  }, [pads, settings.padSound]);
  useEffect(() => {
    pads.setFilter(settings.padCutoff ?? 1800, settings.padResonance ?? 0.8);
  }, [pads, settings.padCutoff, settings.padResonance]);
  useEffect(() => {
    pads.setCrossfade(settings.padCrossfade ?? 3.0);
  }, [pads, settings.padCrossfade]);
  useEffect(() => {
    engine
      .setDualDeviceConfig(
        settings.useDualAudioDevices ?? false,
        settings.outputDevice || '',
        settings.secondaryOutputDevice || '',
      )
      .then(() => setHwStats(engine.getHardwareStats()))
      .catch(() => {});
  }, [engine, settings.useDualAudioDevices, settings.outputDevice, settings.secondaryOutputDevice]);

  useEffect(() => {
    engine.setSmartRouting(settings.smartRouting);
  }, [engine, settings.smartRouting]);

  useEffect(() => {
    engine.setAsioConfig(
      settings.audioDriverType || 'WASAPI',
      settings.asioDriverName || 'WASAPI Nativo',
      settings.asioBufferSize || 128,
      settings.asioSampleRate || 48000,
    );
    setHwStats(engine.getHardwareStats());
  }, [
    engine,
    settings.audioDriverType,
    settings.asioDriverName,
    settings.asioBufferSize,
    settings.asioSampleRate,
  ]);

  const updateSong = useCallback((id: string, patch: Partial<Song> | ((s: Song) => Partial<Song>)) => {
    setSongs((list) =>
      list.map((s) => {
        if (s.id !== id) return s;
        const resolved = typeof patch === 'function' ? patch(s) : patch;
        return { ...s, ...resolved };
      }),
    );
  }, []);

  // ------------------------------------------------------------ mixer + SmartRouting + Multichannel → engine
  useEffect(() => {
    if (!song) return;
    const anySolo = song.tracks.some((t) => t.solo && t.kind !== 'guide');
    for (const t of song.tracks) {
      const audible = !t.mute && (!anySolo || t.solo || t.kind === 'click');
      const outBus = t.output ?? (t.kind === 'click' ? 'OUT_6' : t.kind === 'guide' ? 'OUT_5' : 'OUT_1_2');
      let effectivePan = t.pan;
      if (outBus === 'OUT_1_L') {
        effectivePan = -1; // 100% Left (Out 1)
      } else if (outBus === 'OUT_2_R') {
        effectivePan = 1; // 100% Right (Out 2)
      } else if (!hwStats.multichannel) {
        // 2-channel stereo interface:
        // Out 6 (Click) pans 100% Left; Out 5 (Guide) pans 100% Right or custom pan
        // Backing tracks on Out 1/2 or Out 3/4 pan 100% Right for zero bleed when SmartRouting is active
        if (outBus === 'OUT_6' || t.kind === 'click') {
          effectivePan = -1;
        } else if (outBus === 'OUT_5' || t.kind === 'guide') {
          effectivePan = t.pan !== 0 ? t.pan : 1;
        } else if (settings.smartRouting) {
          effectivePan = 1;
        }
      }
      const bus = inferTrackBus(t);
      const pitchEnabled = isTrackPitched({ ...t, bus });
      engine.setTrackMix(t.id, t.volume, effectivePan, audible, outBus, bus, pitchEnabled);
    }
  }, [engine, song, settings.smartRouting, hwStats.multichannel]);

  // ------------------------------------------------------------ Studio Pitch Pro DSP parameters → engine (Real-Time)
  useEffect(() => {
    if (!song) return;
    engine.setPitchParams(
      song.pitchOffset ?? 0,
      song.pitchCents ?? 0,
      song.pitchMode ?? 'PRO_SOLA',
      song.formantPreserve ?? 0.75,
    );
  }, [engine, song?.id, song?.pitchOffset, song?.pitchCents, song?.pitchMode, song?.formantPreserve]);

  // Sync Software Metronome settings to engine
  useEffect(() => {
    engine.setInternalClickMix(
      settings.internalClickVolume ?? 0.75,
      Boolean(settings.internalClickMute),
      settings.internalClickOutput ?? 'OUT_6',
    );
  }, [engine, settings.internalClickVolume, settings.internalClickMute, settings.internalClickOutput]);

  // Sync Software Neural Guide IA settings to engine
  useEffect(() => {
    engine.setInternalGuideMix(
      settings.autoGuideVolume ?? 0.9,
      Boolean(settings.autoGuideMute || !settings.guideEnabled),
      settings.autoGuideOutput ?? 'OUT_5',
    );
  }, [engine, settings.autoGuideVolume, settings.autoGuideMute, settings.guideEnabled, settings.autoGuideOutput]);

  // ------------------------------------------------------------ song loading (pure stems; pitch shifting is real-time in StudioPitchBusRack)
  const buildBuffers = useCallback(
    async (s: Song, onProgress: (p: number) => void) => {
      const map = new Map<string, AudioBuffer>();
      if (s.source === 'demo') {
        const r = await renderDemo(s, onProgress);
        r.forEach((b, k) => map.set(k, b));
      } else {
        let rawMap = rawImportedRef.current.get(s.id);
        if (!rawMap) {
          rawMap = new Map<string, AudioBuffer>();
          const fileTracks = s.tracks.filter((t) => Boolean(t.fileName));
          let n = 0;
          for (const tr of fileTracks) {
            const ab = await loadStemBuffer(s.id, tr.id);
            if (ab) {
              try {
                rawMap.set(tr.id, await decodeAudioDataSafe(engine.ctx, ab));
              } catch (err) {
                console.warn(`Aviso ao decodificar faixa "${tr.name}":`, err);
              }
            }
            onProgress(++n / Math.max(1, fileTracks.length));
          }
          // Legacy fallback if song was saved under single-key format
          if (rawMap.size === 0 && fileTracks.length > 0) {
            const files = await loadStems(s.id, fileTracks.map((t) => t.id));
            if (files) {
              const ids = Object.keys(files);
              let k = 0;
              for (const id of ids) {
                try {
                  rawMap.set(id, await decodeAudioDataSafe(engine.ctx, files[id].slice(0)));
                } catch (err) {
                  console.warn(`Aviso ao decodificar faixa (${id}):`, err);
                }
                onProgress(++k / Math.max(1, ids.length));
              }
            }
          }
          rawImportedRef.current.set(s.id, rawMap);
        }
        rawMap.forEach((buf, tid) => map.set(tid, buf));
        onProgress(1);

        // Check and auto-split any combined Click/Guide stem or dual-channel stereo Click stem
        for (const tr of s.tracks) {
          const buf = map.get(tr.id);
          if (!buf) continue;
          const isCombinedName = isCombinedClickGuide(tr.name) || (tr.fileName ? isCombinedClickGuide(tr.fileName) : false);
          const isDual = (tr.kind === 'click' || tr.kind === 'guide' || isCombinedName) && isDualChannelClickGuide(buf);
          if (isCombinedName || isDual) {
            const split = splitStereoClickGuide(engine.ctx, buf);
            map.set(tr.id, split.clickBuffer);
            tr.name = 'CLICK';
            tr.kind = 'click';
            tr.output = 'OUT_6';
            tr.bus = 'UTILITY';

            let guide = s.tracks.find((t) => t.kind === 'guide' && t.id !== tr.id);
            if (!guide) {
              const guideId = uid('tr_guide');
              guide = {
                id: guideId,
                name: 'GUIA',
                color: '#0099FF',
                kind: 'guide',
                bus: 'UTILITY',
                output: 'OUT_5',
                volume: 0.9,
                pan: 0,
                mute: false,
                solo: false,
                fileName: tr.fileName,
              };
              s.tracks.push(guide);
              map.set(guideId, split.guideBuffer);
            } else {
              map.set(guide.id, split.guideBuffer);
              if (!guide.fileName && tr.fileName) guide.fileName = tr.fileName;
            }
          }
        }
      }
      // Only synthesize a click track if NO real recorded click stem is present in this multitrack
      const hasRecordedClickStem = s.tracks.some((t) => t.kind === 'click' && (Boolean(t.fileName) || map.has(t.id)));
      const click = s.tracks.find((t) => t.kind === 'click' && !t.fileName);
      if (click && !hasRecordedClickStem) {
        map.set(
          click.id,
          renderClick(
            engine.ctx,
            s.bpm,
            s.beatsPerBar,
            s.duration,
            s.firstBeat,
            settings.clickSubdivision ?? (settings.clickSubdivide ? '1/8' : '1/4'),
            settings.clickSound ?? 'woodblock',
          ),
        );
      }
      return map;
    },
    [engine, settings.clickSubdivide, settings.clickSubdivision, settings.clickSound],
  );

  const loadEntryList = (s: Song, map: Map<string, AudioBuffer>) =>
    s.tracks
      .filter((t) => map.has(t.id) || t.kind === 'guide')
      .map((t) => {
        const bus = inferTrackBus(t);
        const pitchEnabled = isTrackPitched({ ...t, bus });
        return {
          id: t.id,
          buffer: map.get(t.id) ?? null,
          output: t.output ?? (t.kind === 'click' ? 'OUT_6' : t.kind === 'guide' ? 'OUT_5' : 'OUT_1_2'),
          bus,
          pitchEnabled,
        };
      });

  const loadSong = useCallback(
    async (id: string, autoplay = false, forceRebuild = false, explicitSong?: Song) => {
      const rawS = explicitSong ?? songs.find((x) => x.id === id);
      if (!rawS) return;
      const s = ensureUtilityTracks(rawS);
      const prevPos = forceRebuild ? engine.position : 0;
      const wasPlaying = forceRebuild ? engine.playing : autoplay;
      engine.stop();
      window.speechSynthesis?.cancel();
      setPlaying(false);
      if (!forceRebuild) {
        setQueued(null);
        setLoopSectionId(null);
        setPos(0);
      }
      setCurrentId(id);
      if (forceRebuild) {
        buffersRef.current.delete(id);
        peaksRef.current.delete(id);
      }
      let map = buffersRef.current.get(id);
      if (!map) {
        setLoading({ id, progress: 0 });
        try {
          map = await buildBuffers(s, (p) => setLoading({ id, progress: p }));
        } catch (e) {
          setLoading(null);
          alert(`Não foi possível carregar a música: ${(e as Error).message}`);
          return;
        }
        buffersRef.current.set(id, map);
        setLoading(null);
      }
      engine.load(loadEntryList(s, map));
      engine.setPitchParams(
        s.pitchOffset ?? 0,
        s.pitchCents ?? 0,
        s.pitchMode ?? 'PRO_SOLA',
        s.formantPreserve ?? 0.75,
      );
      if (!peaksRef.current.has(id)) {
        const audio = s.tracks.filter((t: Track) => t.kind === 'audio' && map!.has(t.id)).map((t: Track) => map!.get(t.id)!);
        peaksRef.current.set(id, computePeaks(audio, 2000, s.duration));
      }
      setPeaksVersion((v) => v + 1);
      engine.setRate(rate);
      if (prevPos > 0) engine.seek(prevPos);
      if (wasPlaying) {
        await engine.play(prevPos);
        setPlaying(true);
      }
    },
    [songs, engine, buildBuffers, rate],
  );

  // load first song on start
  useEffect(() => {
    if (!currentId && setlistSongs[0]) loadSong(setlistSongs[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-render click when subdivision or timbre setting changes
  useEffect(() => {
    if (!song) return;
    const map = buffersRef.current.get(song.id);
    const click = song.tracks.find((t) => t.kind === 'click' && !t.fileName);
    if (map && click) {
      map.set(
        click.id,
        renderClick(
          engine.ctx,
          song.bpm,
          song.beatsPerBar,
          song.duration,
          song.firstBeat,
          settings.clickSubdivision ?? (settings.clickSubdivide ? '1/8' : '1/4'),
          settings.clickSound ?? 'woodblock',
        ),
      );
      const p = engine.position;
      const wasPlaying = engine.playing;
      engine.load(loadEntryList(song, map));
      engine.seek(p);
      if (wasPlaying) engine.play(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.clickSubdivide, settings.clickSubdivision, settings.clickSound]);

  // Sync metronome settings to AudioEngine
  useEffect(() => {
    engine.setOnMetronomeBeat((b) => setAutonomousBeat(b));
    engine.setAutonomousClick(autonomousClick);
  }, [engine, autonomousClick]);

  useEffect(() => {
    const bpm = song ? song.bpm * rate : 120;
    const beats = song?.beatsPerBar || 4;
    engine.setMetronomeConfig(
      bpm,
      beats,
      settings.clickSubdivision ?? (settings.clickSubdivide ? '1/8' : '1/4'),
      settings.clickSound ?? 'woodblock',
    );
  }, [engine, song, rate, settings.clickSubdivision, settings.clickSubdivide, settings.clickSound]);

  const toggleAutonomousClick = useCallback(() => {
    setAutonomousClick((prev) => {
      const next = !prev;
      engine.setAutonomousClick(next);
      try {
        localStorage.setItem('wpp_autonomous_click', next ? 'true' : 'false');
      } catch {}
      return next;
    });
  }, [engine]);

  // ------------------------------------------------------------ scheduler & routable Guide cue
  const songRef = useRef(song);
  const queuedRef = useRef(queued);
  const loopRef = useRef(loopSectionId);
  const loopModeRef = useRef(loopMode);
  const settingsRef = useRef(settings);
  const setlistRef = useRef(setlistSongs);
  songRef.current = song;
  queuedRef.current = queued;
  loopRef.current = loopSectionId;
  loopModeRef.current = loopMode;
  settingsRef.current = settings;
  setlistRef.current = setlistSongs;
  const pendingUntil = useRef(0);
  const spoken = useRef('');
  const firedCuesRef = useRef(new Set<string>());
  const endHandled = useRef(false);
  const loadSongRef = useRef(loadSong);
  loadSongRef.current = loadSong;

  const sendMidiOutCue = useCallback((cue: MidiCuePin) => {
    setMidiOutFlash(true);
    setTimeout(() => setMidiOutFlash(false), 450);
    const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<any> };
    if (nav.requestMIDIAccess) {
      nav
        .requestMIDIAccess()
        .then((access) => {
          const outputs = Array.from(access.outputs.values()) as any[];
          const status = (0x90 | ((cue.channel - 1) & 0x0f)) & 0xff;
          outputs.forEach((out) => {
            try {
              out.send([status, cue.number & 0x7f, cue.value & 0x7f]);
            } catch {
              /* ignore */
            }
          });
        })
        .catch(() => {});
    }
  }, []);

  const speak = useCallback(
    (section: Section, isJumpOrLoop: boolean, forceTest = false) => {
      const s = songRef.current;
      const cfg = settingsRef.current;
      const guide = s?.tracks.find((t) => t.kind === 'guide');
      const autoVol = cfg.autoGuideVolume ?? 0.9;
      if (!forceTest) {
        if (!cfg.guideEnabled || cfg.autoGuideMute || autoVol <= 0.001) return;
        if (guide && guide.mute) return;
        if (s?.guideMode === 'SILENCE_ON_JUMP' && isJumpOrLoop) return;
        const anySolo = s?.tracks.some((t) => t.solo && t.kind !== 'guide') ?? false;
        if (anySolo && guide && !guide.solo) return;
      }

      const effectiveVol = autoVol;

      // Spoken vocal announcement via selected Neural AI Guide Voice pack
      const guideCtx = engine.getGuideContext();
      const guideDest = engine.getGuideDestinationNode();
      speakWithGuidePack(
        guideCtx,
        guideDest,
        section.label,
        section.type,
        cfg.guideVoicePack ?? 'neural_pt_female',
        cfg.guideVoice,
        effectiveVol,
        cfg.guidePitch ?? 1.0,
        cfg.guideRate ?? 1.12,
      );

      setGuideFlash(section.label);
      setTimeout(() => setGuideFlash(null), 1300);
    },
    [engine],
  );

  useEffect(() => {
    const id = window.setInterval(() => {
      const s = songRef.current;
      if (!engine.playing || !s) return;
      const now = engine.ctx.currentTime;
      const p = engine.position;
      const barLen = (60 / s.bpm) * s.beatsPerBar;

      // end of song — handle per-song transition connector (STOP, AUTO_ADVANCE, OVERLAP, CROSSFADE)
      if (engine.duration > 1 && p >= engine.duration - 0.03 && now > pendingUntil.current) {
        if (endHandled.current) return;
        endHandled.current = true;
        engine.stop();
        setPlaying(false);
        setPos(0);
        setQueued(null);
        const list = setlistRef.current;
        const i = list.findIndex((x) => x.id === s.id);
        const nextSong = list[i + 1];
        const tr: SongTransition =
          s.transitionAfter ?? (settingsRef.current.autoAdvance ? 'OVERLAP' : 'AUTO_ADVANCE');
        if (nextSong && tr !== 'STOP') {
          if (tr === 'CROSSFADE') {
            const nextKey = transposeKey(nextSong.key, nextSong.pitchOffset ?? 0);
            pads.play(nextKey);
            setPadKey(nextKey);
            loadSongRef.current(nextSong.id, true);
          } else if (tr === 'OVERLAP') {
            loadSongRef.current(nextSong.id, true);
          } else if (tr === 'AUTO_ADVANCE') {
            loadSongRef.current(nextSong.id, false);
          }
        }
        return;
      }
      endHandled.current = false;

      // Fire MIDI Out Cue pins (ProPresenter / DMX) when playhead crosses them
      if (s.midiCues && s.midiCues.length > 0) {
        for (const cue of s.midiCues) {
          const cueKey = `${s.id}:${cue.id}`;
          if (p >= cue.time && p < cue.time + 0.25 && !firedCuesRef.current.has(cueKey)) {
            firedCuesRef.current.add(cueKey);
            sendMidiOutCue(cue);
          }
        }
      }

      if (now < pendingUntil.current) return;

      const curIdx = sectionIndexAt(s, p);
      let plan: Plan | null = queuedRef.current;
      if (!plan && loopRef.current) {
        const li = s.sections.findIndex((x) => x.id === loopRef.current);
        const ls = s.sections[li];
        if (ls && curIdx === li) plan = { index: li, to: ls.start, boundary: ls.end, loop: true };
      }

      // guide cue — one bar before the next boundary
      let upcoming: { pos: number; section: Section; isJump: boolean } | null = null;
      if (plan) upcoming = { pos: plan.boundary, section: s.sections[plan.index], isJump: true };
      else if (curIdx >= 0 && s.sections[curIdx + 1]) {
        upcoming = { pos: s.sections[curIdx].end, section: s.sections[curIdx + 1], isJump: false };
      }
      if (upcoming && upcoming.section) {
        const key = `${upcoming.section.id}@${upcoming.pos.toFixed(2)}`;
        const lead = Math.min(barLen, 2.4 * engine.playbackRate + 0.6);
        if (p >= upcoming.pos - lead && p < upcoming.pos && spoken.current !== key) {
          spoken.current = key;
          // CRITICAL: Suppress synthetic TTS guide cues if the multitrack already has a recorded vocal guide stem
          const hasRecordedAudioGuide = s.tracks.some(
            (t) => t.kind === 'guide' && (Boolean(t.fileName) || Boolean(buffersRef.current.get(s.id)?.get(t.id))),
          );
          if (!hasRecordedAudioGuide) {
            speak(upcoming.section, upcoming.isJump);
          }
        }
      }

      if (plan) {
        const when = engine.ctxTimeFor(plan.boundary);
        if (when - now < 0.12) {
          engine.jumpAt(plan.to, when);
          pendingUntil.current = Math.max(when, now) + 0.03;
          if (!plan.loop) {
            setTimeout(() => setQueued(null), Math.max(0, (when - now) * 1000));
          } else if (loopModeRef.current === 'once') {
            // Loop 1x: after repeating once, automatically release the loop
            setTimeout(() => setLoopSectionId(null), Math.max(0, (when - now) * 1000 + 40));
          }
        }
      }
    }, 15);
    return () => clearInterval(id);
  }, [engine, speak, pads, sendMidiOutCue]);

  // UI position refresh
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setPos(engine.position);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  // ------------------------------------------------------------ transport actions
  const togglePlay = useCallback(async () => {
    if (!song || loading) return;
    if (!accessCheck.allowed) return;
    if (engine.playing) {
      engine.pause();
      window.speechSynthesis?.cancel();
      setPlaying(false);
    } else {
      spoken.current = '';
      await engine.play();
      setPlaying(true);
    }
  }, [engine, song, loading, accessCheck.allowed]);

  useEffect(() => {
    if (!accessCheck.allowed && engine.playing) {
      engine.stop();
      window.speechSynthesis?.cancel();
      setPlaying(false);
    }
  }, [accessCheck.allowed, engine]);

  /**
   * Stop / Reset (Stage Spec):
   * - 1 click while playing pauses at current position
   * - Clicking again while paused (or double-clicking Stop) resets playhead to 0:00
   */
  const stop = useCallback(() => {
    window.speechSynthesis?.cancel();
    setQueued(null);
    setFading(false);
    pendingUntil.current = 0;
    firedCuesRef.current.clear();
    if (engine.playing) {
      engine.pause();
      setPlaying(false);
    } else {
      engine.stop();
      setPlaying(false);
      setPos(0);
    }
  }, [engine]);

  const seek = useCallback(
    (t: number) => {
      setQueued(null);
      pendingUntil.current = 0;
      spoken.current = '';
      firedCuesRef.current.clear();
      engine.seek(t);
    },
    [engine],
  );

  /** Auto-Fade: Fades out all musical stems over 5s while keeping Click and Guide playing! */
  const fade = useCallback(async () => {
    if (!engine.playing) return;
    setFading(true);
    await engine.fadeOut(settings.fadeSeconds ?? 5, true);
    setFading(engine.stemsFadedOut);
  }, [engine, settings.fadeSeconds]);

  const gotoSong = useCallback(
    (dir: 1 | -1) => {
      const i = setlistSongs.findIndex((s) => s.id === currentId);
      const next = setlistSongs[i + dir];
      if (next) loadSong(next.id, false);
    },
    [setlistSongs, currentId, loadSong],
  );

  const queueSection = useCallback(
    (index: number, mode: JumpMode = settings.jumpMode) => {
      if (!song) return;
      const target = song.sections[index];
      if (!target) return;
      if (!engine.playing) {
        seek(target.start);
        return;
      }
      if (queued && queued.index === index && engine.ctx.currentTime >= pendingUntil.current) {
        setQueued(null);
        return;
      }
      const p = engine.position;
      const barLen = (60 / song.bpm) * song.beatsPerBar;
      let boundary: number;
      if (mode === 'now') boundary = p + 0.06 * engine.playbackRate;
      else if (mode === 'bar') boundary = song.firstBeat + Math.ceil((p - song.firstBeat + 0.08) / barLen) * barLen;
      else {
        const cur = song.sections[sectionIndexAt(song, p)];
        boundary = cur ? cur.end : p;
        if (boundary - p < 0.08) boundary = song.firstBeat + Math.ceil((p - song.firstBeat + 0.08) / barLen) * barLen;
      }
      spoken.current = '';
      setQueued({ index, to: target.start, boundary });
    },
    [song, engine, settings.jumpMode, queued, seek],
  );

  const queueNextByType = useCallback(
    (type: SectionType) => {
      if (!song) return;
      const cur = sectionIndexAt(song, engine.position);
      let idx = song.sections.findIndex((s, i) => i > cur && s.type === type);
      if (idx === -1) idx = song.sections.findIndex((s) => s.type === type);
      if (idx !== -1) queueSection(idx);
    },
    [song, engine, queueSection],
  );

  const toggleCurrentLoop = useCallback(
    (mode: LoopMode = 'infinite') => {
      if (!song) return;
      const cur = song.sections[sectionIndexAt(song, engine.position)];
      if (!cur) return;
      if (loopSectionId === cur.id && loopMode === mode) {
        setLoopSectionId(null);
      } else {
        setLoopMode(mode);
        setLoopSectionId(cur.id);
      }
    },
    [song, engine, loopSectionId, loopMode],
  );

  const changeRate = useCallback(
    (r: number) => {
      const v = Math.round(Math.max(0.5, Math.min(1.5, r)) * 100) / 100;
      engine.setRate(v);
      setRate(v);
      pendingUntil.current = 0;
      setQueued((q) => (q ? { ...q } : q));
    },
    [engine],
  );

  /** Real-time smooth pitch-shift via StudioPitchBusRack (AudioWorklet SOLA + Drum Bypass). */
  const setPitchSemitones = useCallback(
    (nextOffset: number) => {
      if (!song) return;
      const clamped = Math.max(-6, Math.min(6, Math.round(nextOffset)));
      updateSong(song.id, { pitchOffset: clamped });
      engine.setPitchParams(
        clamped,
        song.pitchCents ?? 0,
        song.pitchMode ?? 'PRO_SOLA',
        song.formantPreserve ?? 0.75,
      );
      const newKey = transposeKey(song.key, clamped);
      if (padKey) {
        pads.play(newKey);
        setPadKey(newKey);
      }
    },
    [song, updateSong, engine, padKey, pads],
  );

  const changePitchOffset = useCallback(
    (delta: number) => {
      if (!song) return;
      setPitchSemitones((song.pitchOffset ?? 0) + delta);
    },
    [song, setPitchSemitones],
  );

  /** Reset ALL edits on the current song: pitchOffset=0, pitchCents=0, rate=1.0, faders/mute/solo/pan/outputs, and sections */
  const resetCurrentSongAll = useCallback(() => {
    if (!song) return;
    changeRate(1);
    setQueued(null);
    setLoopSectionId(null);
    const map = buffersRef.current.get(song.id);
    const freshSections = detectSectionsFromAudio(song, map);

    updateSong(song.id, (s) => ({
      pitchOffset: 0,
      pitchCents: 0,
      pitchMode: 'PRO_SOLA',
      formantPreserve: 0.75,
      sections: freshSections,
      tracks: s.tracks.map((t) => {
        const bus = inferTrackBus(t);
        return {
          ...t,
          volume: t.kind === 'click' ? 0.75 : 0.9,
          pan: 0,
          mute: false,
          solo: false,
          bus,
          pitchShift: isTrackPitched({ ...t, bus }),
          output: t.kind === 'click' ? 'OUT_6' : t.kind === 'guide' ? 'OUT_5' : 'OUT_1_2',
        };
      }),
    }));
    engine.setPitchParams(0, 0, 'PRO_SOLA', 0.75);
    if (padKey) {
      pads.play(song.key);
      setPadKey(song.key);
    }
  }, [song, changeRate, updateSong, engine, padKey, pads]);

  /** Select an existing Pad Folder Bank */
  const handleSelectPadBank = useCallback(
    async (bankId: string) => {
      setSettings((s) => ({ ...s, activePadBankId: bankId, padSound: 'custom_folder' }));
      pads.setActiveBank(bankId);
      const bank = settings.padBanks?.find((b) => b.id === bankId);
      if (bank) {
        for (const k of bank.keys) {
          const ab = await loadPadBankBuffer(bankId, k);
          if (ab) {
            try {
              const decoded = await decodeAudioDataSafe(engine.ctx, ab);
              pads.setBankBuffer(bankId, k, decoded);
            } catch {
              /* ignore */
            }
          }
        }
      }
    },
    [engine, pads, settings.padBanks],
  );

  /** Create a new named Pad Folder Bank */
  const handleCreatePadBank = useCallback(
    async (name: string, fileList: FileList | File[]) => {
      const files = Array.from(fileList).filter(isValidAudioCandidate);
      if (files.length === 0) {
        alert('Nenhum arquivo de áudio válido (.wav, .mp3, .flac, .ogg, .m4a, .aiff) encontrado.');
        return;
      }
      const bankId = `bank_${Date.now()}`;
      const loadedKeys: string[] = [];

      for (const f of files) {
        const key = parsePadKeyFromFileName(f.name);
        if (!key) continue;
        try {
          const ab = await f.arrayBuffer();
          const decoded = await decodeAudioDataSafe(engine.ctx, ab.slice(0));
          pads.setBankBuffer(bankId, key, decoded);
          await savePadBankFile(bankId, key, f);
          if (!loadedKeys.includes(key)) loadedKeys.push(key);
        } catch (err) {
          console.warn(`Falha ao carregar Pad ${f.name}:`, err);
        }
      }

      if (loadedKeys.length === 0) {
        alert(
          'Não foi possível identificar as notas nos nomes dos arquivos. Exemplo de nomes aceitos: C.wav, C#.wav, D.wav, Eb.wav, E.wav, F.wav, etc.',
        );
        return;
      }

      const newBank: PadFolderBank = {
        id: bankId,
        name: name.trim() || 'Nova Pasta de Pads',
        keys: loadedKeys,
        createdAt: Date.now(),
      };

      pads.setActiveBank(bankId);
      pads.setSound('custom_folder');

      setSettings((s) => {
        const currentBanks = s.padBanks ? [...s.padBanks] : [];
        return {
          ...s,
          padBanks: [...currentBanks, newBank],
          activePadBankId: bankId,
          padSound: 'custom_folder',
          customPadFolderName: newBank.name,
          customPadKeys: loadedKeys,
        };
      });
    },
    [engine, pads],
  );

  /** Rename an existing Pad Folder Bank */
  const handleRenamePadBank = useCallback((bankId: string, newName: string) => {
    if (!newName.trim()) return;
    setSettings((s) => ({
      ...s,
      padBanks: (s.padBanks ?? []).map((b) => (b.id === bankId ? { ...b, name: newName.trim() } : b)),
      customPadFolderName: s.activePadBankId === bankId ? newName.trim() : s.customPadFolderName,
    }));
  }, []);

  /** Delete a Pad Folder Bank */
  const handleDeletePadBank = useCallback(
    async (bankId: string) => {
      const bank = settings.padBanks?.find((b) => b.id === bankId);
      if (!bank) return;
      if (!window.confirm(`Tem certeza que deseja excluir a pasta de pads "${bank.name}"?`)) return;

      await deletePadBankStorage(bankId, bank.keys);
      pads.removeBank(bankId);

      setSettings((s) => {
        const remaining = (s.padBanks ?? []).filter((b) => b.id !== bankId);
        const nextActiveId = remaining[0]?.id ?? 'default';
        if (remaining.length > 0) {
          pads.setActiveBank(nextActiveId);
        }
        return {
          ...s,
          padBanks: remaining,
          activePadBankId: nextActiveId,
          customPadFolderName: remaining[0]?.name ?? '',
          customPadKeys: remaining[0]?.keys ?? [],
          padSound: remaining.length === 0 && s.padSound === 'custom_folder' ? 'warm' : s.padSound,
        };
      });
    },
    [pads, settings.padBanks],
  );

  /** Add more audio files to an existing Pad Folder Bank */
  const handleAddFilesToPadBank = useCallback(
    async (bankId: string, fileList: FileList | File[]) => {
      const files = Array.from(fileList).filter(isValidAudioCandidate);
      if (files.length === 0) return;
      const bank = settings.padBanks?.find((b) => b.id === bankId);
      if (!bank) return;

      const updatedKeys = [...bank.keys];
      for (const f of files) {
        const key = parsePadKeyFromFileName(f.name);
        if (!key) continue;
        try {
          const ab = await f.arrayBuffer();
          const decoded = await decodeAudioDataSafe(engine.ctx, ab.slice(0));
          pads.setBankBuffer(bankId, key, decoded);
          await savePadBankFile(bankId, key, f);
          if (!updatedKeys.includes(key)) updatedKeys.push(key);
        } catch (err) {
          console.warn(`Falha ao adicionar áudio ${f.name}:`, err);
        }
      }

      setSettings((s) => ({
        ...s,
        padBanks: (s.padBanks ?? []).map((b) => (b.id === bankId ? { ...b, keys: updatedKeys } : b)),
        customPadKeys: s.activePadBankId === bankId ? updatedKeys : s.customPadKeys,
      }));
    },
    [engine, pads, settings.padBanks],
  );

  /** Import a custom folder of Pad audio files (C, C#, D, ..., B) */
  const handleImportPadFolder = useCallback(
    async (fileList: FileList) => {
      const files = Array.from(fileList).filter(isValidAudioCandidate);
      if (files.length === 0) {
        alert('Nenhum arquivo de áudio válido (.wav, .mp3, .flac, .ogg, .m4a, .aiff) encontrado na pasta selecionada.');
        return;
      }
      const firstRel = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath || '';
      const folderName = firstRel.includes('/') ? firstRel.split('/')[0] : 'Pads Personalizados';
      await handleCreatePadBank(folderName, files);
    },
    [handleCreatePadBank],
  );

  // Draggable resize handlers for Timeline (Wavesong) and Mixer (Faders)
  const startResizeTimeline = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = settings.timelineHeight ?? 145;
      const onMove = (ev: MouseEvent) => {
        const nextH = Math.max(95, Math.min(340, startH + (ev.clientY - startY)));
        setSettings((s) => ({ ...s, timelineHeight: nextH }));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [settings.timelineHeight],
  );

  const startResizeMixer = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = settings.mixerHeight ?? 280;
      const onMove = (ev: MouseEvent) => {
        const nextH = Math.max(190, Math.min(540, startH - (ev.clientY - startY)));
        setSettings((s) => ({ ...s, mixerHeight: nextH }));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [settings.mixerHeight],
  );

  const togglePad = useCallback(
    (key: string) => {
      if (padKey === key) {
        pads.stop();
        setPadKey(null);
      } else {
        pads.play(key);
        setPadKey(key);
      }
    },
    [pads, padKey],
  );

  const triggerMidiMapping = useCallback(
    (m: MidiMapping) => {
      if (m.actionType === 'PLAY_PAUSE') togglePlay();
      else if (m.actionType === 'STOP') stop();
      else if (m.actionType === 'LOOP_CURRENT') toggleCurrentLoop();
      else if (m.actionType === 'FADE_OUT') fade();
      else if (m.actionType === 'JUMP_NEXT_TYPE') queueNextByType(m.targetValue as SectionType);
      else if (m.actionType === 'JUMP_SECTION_INDEX') queueSection(parseInt(m.targetValue, 10) || 0);
    },
    [togglePlay, stop, toggleCurrentLoop, fade, queueNextByType, queueSection],
  );

  const triggerMidiRef = useRef(triggerMidiMapping);
  triggerMidiRef.current = triggerMidiMapping;

  // ------------------------------------------------------------ global WebMIDI listener (always active on stage)
  useEffect(() => {
    const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<any> };
    if (!nav.requestMIDIAccess) return;
    let accessObj: any = null;

    const bindInputs = (access: any) => {
      const inputs = Array.from(access.inputs.values()) as any[];
      setMidiConnectedCount(inputs.length);
      inputs.forEach((input) => {
        input.onmidimessage = (ev: { data: Uint8Array }) => {
          const [status, data1, data2] = ev.data;
          const cmd = status >> 4;
          const ch = (status & 0xf) + 1;
          // Note On (velocity > 0) or CC (value >= 64)
          const isNoteOn = cmd === 9 && data2 > 0;
          const isCC = cmd === 11 && data2 >= 64;
          if (!isNoteOn && !isCC) return;
          setMidiInFlash(true);
          setTimeout(() => setMidiInFlash(false), 350);
          const msgType = isCC ? 'CC' : 'NOTE_ON';
          const mappings = settingsRef.current.midiMappings;
          for (const m of mappings) {
            if (m.channel === ch && m.messageType === msgType && m.controllerNumber === data1) {
              triggerMidiRef.current(m);
            }
          }
        };
      });
    };

    nav
      .requestMIDIAccess()
      .then((access) => {
        accessObj = access;
        bindInputs(access);
        access.onstatechange = () => bindInputs(access);
      })
      .catch(() => {});

    return () => {
      if (accessObj) accessObj.onstatechange = null;
    };
  }, []);

  // ------------------------------------------------------------ keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || dialog) return;
      if (!accessCheck.allowed) return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'Escape') stop();
      else if (e.key === 'f' || e.key === 'F') fade();
      else if (e.key === 'k' || e.key === 'K') toggleAutonomousClick();
      else if (e.key === 'c' || e.key === 'C') setShowChords((x) => !x);
      else if (e.key === 'l' || e.key === 'L') toggleCurrentLoop();
      else if (e.key === 'r' || e.key === 'R') queueNextByType('REFRAO');
      else if (e.key === 'v' || e.key === 'V') queueNextByType('VERSO');
      else if (e.key === 'p' || e.key === 'P') queueNextByType('PONTE');
      else if (e.key === 'e' || e.key === 'E') queueNextByType('FINAL');
      else if (e.key === 'i' || e.key === 'I') queueNextByType('INTRO');
      else if (e.key === 'ArrowRight') gotoSong(1);
      else if (e.key === 'ArrowLeft') gotoSong(-1);
      else if (/^[1-9]$/.test(e.key)) queueSection(parseInt(e.key, 10) - 1);
      else if (e.key === '0') queueSection(9);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, stop, fade, toggleAutonomousClick, gotoSong, queueSection, queueNextByType, toggleCurrentLoop, dialog, accessCheck.allowed]);

  // ------------------------------------------------------------ setlist / library / bus ops
  const unloadActiveSong = useCallback(() => {
    engine.stop();
    engine.load([]);
    window.speechSynthesis?.cancel();
    setPlaying(false);
    setPos(0);
    setQueued(null);
    setLoopSectionId(null);
    setCurrentId(null);
  }, [engine]);

  const syncWebSetlists = useCallback(async () => {
    if (!user) {
      alert('Faça login na sua conta para sincronizar as setlists da Web.');
      setDialog('auth');
      return;
    }
    try {
      const webPlaylists = await authService.getWebPlaylists(user.id);
      if (webPlaylists.length === 0) {
        alert('Nenhuma setlist com multitracks encontrada no painel Web.');
        return;
      }
      // Armazena as playlists e abre o modal de sincronização com progresso visual
      setSyncWebPlaylists(webPlaylists);
      setDialog('sync-web');
    } catch (e) {
      console.error('[Sync] Erro ao buscar playlists da Web:', e);
      alert('Falha ao buscar playlists da Web.');
    }
  }, [user]);

  const updateSetlist = (id: string, patch: Partial<Setlist>) =>
    setSetlists((l) => l.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  // Handler chamado quando o SyncWebModal termina
  const handleSyncComplete = useCallback((syncedCount: number, downloadedCount: number) => {
    // Atualiza as setlists locais com os IDs das playlists sincronizadas
    // O SyncWebModal já fez o download das músicas, agora só criamos/atualizamos as setlists
    authService.getWebPlaylists(user?.id || '').then((webPlaylists) => {
      for (const wp of webPlaylists) {
        const exists = setlists.some((sl) => sl.id === wp.id);
        const songIds = wp.items.map((i) => i.id);
        if (!exists) {
          setSetlists((prev) => [...prev, { id: wp.id, name: wp.name, songIds }]);
        } else {
          updateSetlist(wp.id, { name: wp.name, songIds });
        }
      }
      alert(`${syncedCount} setlist(s) sincronizada(s)! ${downloadedCount} música(s) baixada(s).`);
    }).catch((e) => {
      console.error('[SyncWeb] Erro ao atualizar setlists:', e);
    });
  }, [user, setlists]);

  const addSongToSetlist = (songId: string) => {
    if (!setlist) return;
    const nextIds = setlist.songIds.includes(songId) ? setlist.songIds : [...setlist.songIds, songId];
    updateSetlist(setlist.id, { songIds: nextIds });
    if (!currentId) {
      void loadSong(songId);
    }
  };

  const deleteSong = (songId: string) => {
    const s = songs.find((x) => x.id === songId);
    if (!s) return;
    if (!confirm(`Excluir "${s.name}" da biblioteca?`)) return;
    deleteStems(
      songId,
      s.tracks.map((t) => t.id),
    );
    rawImportedRef.current.delete(songId);
    buffersRef.current.delete(songId);
    peaksRef.current.delete(songId);
    setSongs((l) => l.filter((x) => x.id !== songId));
    setSetlists((l) => l.map((sl) => ({ ...sl, songIds: sl.songIds.filter((x) => x !== songId) })));
    if (currentId === songId) {
      unloadActiveSong();
    }
  };

  const onImported = (s: Song) => {
    const preloaded = (s as unknown as { _preloadedBuffers?: Map<string, AudioBuffer> })._preloadedBuffers;
    if (preloaded && preloaded.size > 0) {
      rawImportedRef.current.set(s.id, preloaded);
      // Pre-seed buffersRef with a clone map so buildBuffers will attach click/guide effortlessly
      buffersRef.current.set(s.id, new Map(preloaded));
    }
    setSongs((l) => (l.some((x) => x.id === s.id) ? l.map((x) => (x.id === s.id ? s : x)) : [...l, s]));
    if (setlist && !setlist.songIds.includes(s.id)) {
      updateSetlist(setlist.id, { songIds: [...setlist.songIds, s.id] });
    }
    setDialog(null);
    void loadSong(s.id, false, true, s);
  };

  // Handler chamado pelo SyncWebModal quando a importação de uma música é concluída
  const handleSyncSongImported = useCallback((importedSong: Song, originalItemId?: string) => {
    onImported(importedSong);
    console.log('[SyncWeb] Música importada e carregada:', importedSong.name);
  }, [onImported]);

  /** Clicking a Setlist card loads it */
  const handleSelectSetlistSong = (id: string) => {
    if (id !== currentId) {
      void loadSong(id);
    }
  };

  const onSongEdited = (edited: Song) => {
    const old = songs.find((s) => s.id === edited.id);
    updateSong(edited.id, edited);
    setDialog(null);
    if (old && (old.bpm !== edited.bpm || old.beatsPerBar !== edited.beatsPerBar || old.firstBeat !== edited.firstBeat)) {
      const map = buffersRef.current.get(edited.id);
      const click = edited.tracks.find((t) => t.kind === 'click' && !t.fileName);
      if (map && click) {
        map.set(
          click.id,
          renderClick(
            engine.ctx,
            edited.bpm,
            edited.beatsPerBar,
            edited.duration,
            edited.firstBeat,
            settings.clickSubdivision ?? (settings.clickSubdivide ? '1/8' : '1/4'),
            settings.clickSound ?? 'woodblock',
          ),
        );
        if (currentId === edited.id) {
          const p = engine.position;
          const wasPlaying = engine.playing;
          engine.load(loadEntryList(edited, map));
          engine.seek(p);
          if (wasPlaying) engine.play(p);
        }
      }
    }
  };

  const handleBusGroup = (bus: BusGroup, action: 'mute' | 'solo' | 'vol', value?: number) => {
    if (!song) return;
    updateSong(song.id, (s) => {
      const members = s.tracks.filter((t) => (t.bus ?? 'KEYS') === bus);
      const allMuted = members.every((m) => m.mute);
      const anySolo = members.some((m) => m.solo);
      return {
        tracks: s.tracks.map((t) => {
          if ((t.bus ?? 'KEYS') !== bus) return t;
          if (action === 'mute') return { ...t, mute: !allMuted };
          if (action === 'solo') return { ...t, solo: !anySolo };
          return { ...t, volume: value ?? t.volume };
        }),
      };
    });
  };

  const curIdx = sectionIndexAt(song, pos);
  const peaks = song ? peaksRef.current.get(song.id) : undefined;
  const getPos = useCallback(() => engine.position, [engine]);
  const effectiveSongKey = song ? transposeKey(song.key, song.pitchOffset ?? 0) : undefined;

  // ------------------------------------------------------------ Remote Control Sync (WebSocket)
  const broadcastCurrentState = useCallback(() => {
    if (!song) {
      void remoteControlService.broadcastState({
        playing: engine.playing,
        position: engine.position,
        duration: 0,
        song: null,
      });
      return;
    }

    const effKey = transposeKey(song.key, song.pitchOffset ?? 0);
    const busGroups = ['CLICK', 'GUIDE', 'DRUMS', 'BASS', 'GUITARS', 'KEYS', 'VOCALS'] as const;
    const busNames: Record<string, string> = {
      CLICK: '⏱️ CLICK',
      GUIDE: '🗣️ GUIA',
      DRUMS: '🥁 BATERIA',
      BASS: '🎸 BAIXO',
      GUITARS: '🎸 GUITARRAS',
      KEYS: '🎹 TECLAS/PAD',
      VOCALS: '🎤 VOCAIS',
    };

    const busesData = busGroups.map((b) => {
      const isUtility = b === 'CLICK' || b === 'GUIDE';
      const members = isUtility
        ? song.tracks.filter((t) => (b === 'CLICK' ? t.kind === 'click' : t.kind === 'guide'))
        : song.tracks.filter((t) => (t.bus ?? 'KEYS') === b);

      const allMuted = members.length > 0 ? members.every((m) => m.mute) : false;
      const anySolo = members.length > 0 ? members.some((m) => m.solo) : false;
      const vol = members.length > 0 ? members[0].volume : 0.85;

      return {
        id: b,
        name: busNames[b] || b,
        vol,
        mute: allMuted,
        solo: anySolo,
      };
    });

    const tracksData = song.tracks.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      vol: t.volume,
      mute: t.mute,
      solo: t.solo,
      color: t.color,
    }));

    void remoteControlService.broadcastState({
      playing: engine.playing,
      position: engine.position,
      duration: song.duration,
      song: {
        id: song.id,
        title: song.name,
        artist: song.artist,
        key: effKey,
        bpm: song.bpm * rate,
        duration: song.duration,
        sections: song.sections.map((sec) => ({
          id: sec.id,
          label: sec.label,
          type: sec.type,
          start: sec.start,
          end: sec.end,
          color: sec.color,
        })),
      },
      queuedSectionId: queued?.to ? song.sections[queued.index]?.id : null,
      loopSectionId,
      autonomousClick,
      tracks: tracksData,
      buses: busesData,
    });
  }, [song, engine, rate, queued, loopSectionId, autonomousClick]);

  // Periodic broadcast for mobile playhead
  useEffect(() => {
    const id = window.setInterval(() => {
      if (engine.playing) {
        broadcastCurrentState();
      }
    }, 200);
    return () => clearInterval(id);
  }, [engine, broadcastCurrentState]);

  // Immediate broadcast on state transition
  useEffect(() => {
    broadcastCurrentState();
  }, [broadcastCurrentState, playing, currentId, rate, loopSectionId, queued]);

  // Handle incoming remote commands
  useEffect(() => {
    const unlistenCount = remoteControlService.onClientCountChange(setRemoteClientsCount);
    const unlistenAction = remoteControlService.onRemoteAction((payload) => {
      switch (payload.action) {
        case 'play':
          if (!engine.playing) void togglePlay();
          break;
        case 'pause':
          if (engine.playing) void togglePlay();
          break;
        case 'stop':
          stop();
          break;
        case 'fade_out':
          void fade();
          break;
        case 'prev_song':
          gotoSong(-1);
          break;
        case 'next_song':
          gotoSong(1);
          break;
        case 'loop_current':
          toggleCurrentLoop();
          break;
        case 'toggle_click':
          toggleAutonomousClick();
          break;
        case 'seek':
          if (typeof payload.position === 'number') {
            seek(payload.position);
          }
          break;
        case 'jump':
          if (song && payload.sectionId) {
            const idx = song.sections.findIndex((x) => x.id === payload.sectionId);
            if (idx >= 0) {
              queueSection(idx, payload.mode || 'bar');
            }
          }
          break;
        case 'track_volume':
          if (song && payload.trackId && typeof payload.value === 'number') {
            updateSong(song.id, (s) => ({
              tracks: s.tracks.map((t) => (t.id === payload.trackId ? { ...t, volume: payload.value } : t)),
            }));
          }
          break;
        case 'track_mute':
          if (song && payload.trackId) {
            updateSong(song.id, (s) => ({
              tracks: s.tracks.map((t) => (t.id === payload.trackId ? { ...t, mute: !t.mute } : t)),
            }));
          }
          break;
        case 'track_solo':
          if (song && payload.trackId) {
            updateSong(song.id, (s) => ({
              tracks: s.tracks.map((t) => (t.id === payload.trackId ? { ...t, solo: !t.solo } : t)),
            }));
          }
          break;
        case 'bus_volume':
          if (payload.bus && typeof payload.value === 'number') {
            if (payload.bus === 'CLICK' || payload.bus === 'GUIDE') {
              const kind = payload.bus === 'CLICK' ? 'click' : 'guide';
              if (song) {
                updateSong(song.id, (s) => ({
                  tracks: s.tracks.map((t) => (t.kind === kind ? { ...t, volume: payload.value } : t)),
                }));
              }
            } else {
              handleBusGroup(payload.bus as BusGroup, 'vol', payload.value);
            }
          }
          break;
        case 'bus_mute':
          if (payload.bus) {
            if (payload.bus === 'CLICK' || payload.bus === 'GUIDE') {
              const kind = payload.bus === 'CLICK' ? 'click' : 'guide';
              if (song) {
                updateSong(song.id, (s) => ({
                  tracks: s.tracks.map((t) => (t.kind === kind ? { ...t, mute: !t.mute } : t)),
                }));
              }
            } else {
              handleBusGroup(payload.bus as BusGroup, 'mute');
            }
          }
          break;
        case 'bus_solo':
          if (payload.bus) {
            if (payload.bus === 'CLICK' || payload.bus === 'GUIDE') {
              const kind = payload.bus === 'CLICK' ? 'click' : 'guide';
              if (song) {
                updateSong(song.id, (s) => ({
                  tracks: s.tracks.map((t) => (t.kind === kind ? { ...t, solo: !t.solo } : t)),
                }));
              }
            } else {
              handleBusGroup(payload.bus as BusGroup, 'solo');
            }
          }
          break;
      }
    });

    return () => {
      unlistenCount();
      unlistenAction();
    };
  }, [engine, togglePlay, stop, fade, gotoSong, seek, toggleCurrentLoop, queueSection, handleBusGroup, song, updateSong]);

  return (
    <div
      className="app"
      style={
        {
          '--timeline-h': `${settings.timelineHeight ?? 145}px`,
          '--mixer-h': `${settings.mixerHeight ?? 280}px`,
        } as React.CSSProperties
      }
    >
      <TopBar
        song={song}
        playing={playing}
        pos={pos}
        duration={engine.duration || song?.duration || 0}
        section={song?.sections[curIdx]}
        rate={rate}
        fading={fading}
        looping={!!loopSectionId}
        padKey={padKey}
        transitionMode={settings.transitionMode}
        masterVolume={settings.masterVolume}
        setlistName={setlist?.name ?? ''}
        hwStats={hwStats}
        midiConnectedCount={midiConnectedCount}
        midiInFlash={midiInFlash}
        midiOutFlash={midiOutFlash}
        editMode={editMode}
        user={user}
        onToggleEditMode={() => setEditMode((x) => !x)}
        onPlay={togglePlay}
        onStop={stop}
        onPrev={() => gotoSong(-1)}
        onNext={() => gotoSong(1)}
        onFade={fade}
        onToggleLoop={() => toggleCurrentLoop('infinite')}
        onTogglePadQuick={() => effectiveSongKey && togglePad(effectiveSongKey)}
        onOpenPadDrawer={() => setDialog('pads-drawer')}
        onToggleFloatingPad={() => setSettings((s) => ({ ...s, floatingPadOpen: !s.floatingPadOpen }))}
        onResetAll={resetCurrentSongAll}
        onImport={() => setDialog('import')}
        onOpenCatalog={() => setDialog('catalog')}
        onOpenAdmin={() => setDialog('admin-panel')}
        onOpenAuth={() => setDialog('auth')}
        onPitchOffset={changePitchOffset}
        onOpenPitchPlugin={() => setDialog('pitch')}
        onRate={changeRate}
        onTransitionMode={(m) => setSettings((s) => ({ ...s, transitionMode: m }))}
        onMasterVolume={(v) => setSettings((s) => ({ ...s, masterVolume: v }))}
        onMidi={() => setDialog('midi')}
        onSettings={() => setDialog('settings')}
        onLibrary={() => setDialog('library')}
        onAi={() => setDialog('ai')}
        remoteClientsCount={remoteClientsCount}
        onOpenRemote={() => setDialog('remote')}
        autonomousClick={autonomousClick}
        autonomousBeat={autonomousBeat}
        onToggleAutonomousClick={toggleAutonomousClick}
      />

      <SetlistStrip
        songs={setlistSongs}
        currentId={currentId}
        loading={loading}
        editMode={editMode}
        onSelect={(id) => void handleSelectSetlistSong(id)}
        onRemove={(id) => {
          if (!setlist) return;
          const nextIds = setlist.songIds.filter((x) => x !== id);
          updateSetlist(setlist.id, { songIds: nextIds });
          if (currentId === id) {
            if (nextIds[0]) void loadSong(nextIds[0]);
            else unloadActiveSong();
          }
        }}
        onReorder={(ids) => setlist && updateSetlist(setlist.id, { songIds: ids })}
        onTransitionChange={(songId, transitionAfter) => updateSong(songId, { transitionAfter })}
        onAdd={() => setDialog('catalog')}
        onOpenPadDrawer={() => setDialog('pads-drawer')}
      />

      <main className="stage">
        {song ? (
          <>
            <Timeline
              key={`${song.id}-${peaksVersion}`}
              song={song}
              peaks={peaks}
              getPos={getPos}
              duration={engine.duration || song.duration}
              queued={queued}
              loopSectionId={loopSectionId}
              loopMode={loopMode}
              loading={loading?.id === song.id ? loading.progress : null}
              onSeek={seek}
              onQueueSection={queueSection}
              onToggleLoopOnce={() => toggleCurrentLoop('once')}
              onToggleLoopInfinite={() => toggleCurrentLoop('infinite')}
            />
            <div
              className="resize-handle-h"
              onMouseDown={startResizeTimeline}
              title="Arraste para cima/baixo para redimensionar a área da Wavesong / Timeline"
            >
              <span />
            </div>
            <SectionGrid
              song={song}
              currentIndex={curIdx}
              pos={pos}
              queued={queued}
              loopSectionId={loopSectionId}
              jumpMode={settings.jumpMode}
              guideEnabled={settings.guideEnabled && !settings.autoGuideMute}
              autoGuideVolume={settings.autoGuideVolume ?? 0.9}
              guideFlash={guideFlash}
              autoAdvance={settings.autoAdvance}
              transitionMode={settings.transitionMode}
              showChords={showChords}
              onQueue={queueSection}
              onQueueByType={queueNextByType}
              onLoop={(id) => setLoopSectionId((x) => (x === id ? null : id))}
              onJumpMode={(m) => setSettings((s) => ({ ...s, jumpMode: m }))}
              onGuide={() =>
                setSettings((s) => ({
                  ...s,
                  guideEnabled: !(s.guideEnabled && !s.autoGuideMute),
                  autoGuideMute: false,
                }))
              }
              onAutoGuideVolume={(v) => setSettings((s) => ({ ...s, autoGuideVolume: v, autoGuideMute: v <= 0.001 }))}
              onGuideMode={(gm: GuideMode) => updateSong(song.id, { guideMode: gm })}
              onAutoAdvance={() => setSettings((s) => ({ ...s, autoAdvance: !s.autoAdvance }))}
              onTransitionMode={(m) => setSettings((s) => ({ ...s, transitionMode: m }))}
              onToggleChords={() => setShowChords((x) => !x)}
              onEdit={() => setDialog('edit')}
              onOpenWaveform={() => setDialog('waveform')}
              onOpenAi={() => setDialog('ai')}
            />
          </>
        ) : (
          <div className="empty-stage">
            <p>Nenhuma música carregada neste Setlist.</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button className="btn primary" onClick={() => setDialog('import')}>
                + Importar Multitracks (ZIP / Pasta)
              </button>
              <button className="btn" onClick={() => setDialog('library')}>
                Abrir Biblioteca ({songs.length})
              </button>
            </div>
          </div>
        )}
      </main>

      <div
        className="resize-handle-h mixer-resize"
        onMouseDown={startResizeMixer}
        title="Arraste para cima/baixo para aumentar ou diminuir a área dos Faders / Mixer"
      >
        <span />
      </div>

      <section className="bottom">
        <div className="bottom-tabs">
          <div className="bottom-tabs-left">
            <button className={bottomTab === 'mixer' ? 'active' : ''} onClick={() => setBottomTab('mixer')}>
              TRACKS MIXER ({song?.tracks.length ?? 0})
            </button>
            <button className={bottomTab === 'buses' ? 'active' : ''} onClick={() => setBottomTab('buses')}>
              BUS MIXER (SUBGRUPOS)
            </button>
            <button className={bottomTab === 'pads' ? 'active' : ''} onClick={() => setBottomTab('pads')}>
              AMBIENT PADS {padKey && <span className="dot-live" />}
            </button>
          </div>
          <div className="bottom-transport">
            <TransportControls
              playing={playing}
              fading={fading}
              looping={!!loopSectionId}
              autonomousClick={autonomousClick}
              onPlay={togglePlay}
              onStop={stop}
              onPrev={() => gotoSong(-1)}
              onNext={() => gotoSong(1)}
              onFade={fade}
              onToggleLoop={() => toggleCurrentLoop('infinite')}
              onToggleAutonomousClick={toggleAutonomousClick}
            />
          </div>
          <div className="bottom-tabs-right">
            <button
              className="pitch-tab-btn"
              onClick={() => setDialog('pitch')}
              title="Abrir Plugin Studio Pitch Pro (Mudança de Tom em Tempo Real, Formantes, Cents e Bypass de Bateria)"
            >
              🎛️ STUDIO PITCH PRO {song && (song.pitchOffset ?? 0) !== 0 ? `(${song.pitchOffset! > 0 ? `+${song.pitchOffset}` : song.pitchOffset} st)` : ''}
            </button>
            <span className="routing-hint">
              {settings.useDualAudioDevices
                ? `🎧 Modo 2 Placas: USB (Tracks FOH Ch 1/2) + Notebook (Guia Ch 3 / Click Ch 4) · 100% Isolado`
                : settings.audioDriverType === 'ASIO'
                  ? `⚡ ASIO: ${settings.asioDriverName || 'ASIO4ALL v2'} (${hwStats.bufferSize || 128} spl · ${hwStats.latencyMs}ms) · Tracks: Ch ${settings.asioOutputMapping?.tracksOutL ?? 1}/${settings.asioOutputMapping?.tracksOutR ?? 2} · Guia: Ch ${settings.asioOutputMapping?.guideOut ?? 3} · Click: Ch ${settings.asioOutputMapping?.clickOut ?? 4}`
                  : hwStats.multichannel
                    ? `Multicanal Discreto (${hwStats.maxChannels}ch): Out 1/2 P.A. · Out 3/4 Sub · Out 5 Guia · Out 6 Click`
                    : settings.smartRouting
                      ? 'SmartRouting™ Estéreo: Click/Guia (Out 5/6 → L 100%) · Backing Tracks (Out 1-4 → R 100%)'
                      : 'Mixagem Estéreo Padrão (Out 1/2)'}
            </span>
          </div>
        </div>
        {bottomTab === 'mixer' || bottomTab === 'buses' ? (
          <Mixer
            song={song}
            engine={engine}
            mode={bottomTab === 'buses' ? 'buses' : 'tracks'}
            smartRouting={settings.smartRouting}
            guideFlash={!!guideFlash}
            autoGuideVolume={settings.autoGuideVolume ?? 0.9}
            autoGuideMute={Boolean(settings.autoGuideMute || !settings.guideEnabled)}
            autoGuideOutput={settings.autoGuideOutput ?? 'OUT_5'}
            masterVolume={settings.masterVolume}
            clickSubdivision={settings.clickSubdivision ?? (settings.clickSubdivide ? '1/8' : '1/4')}
            clickSound={settings.clickSound ?? 'woodblock'}
            autonomousClick={autonomousClick}
            internalClickVolume={settings.internalClickVolume ?? 0.75}
            internalClickMute={Boolean(settings.internalClickMute)}
            internalClickOutput={settings.internalClickOutput ?? 'OUT_6'}
            onToggleAutonomousClick={toggleAutonomousClick}
            onClickSubdivision={(clickSubdivision) =>
              setSettings((s) => ({ ...s, clickSubdivision, clickSubdivide: clickSubdivision !== '1/4' }))
            }
            onClickSound={(clickSound) => setSettings((s) => ({ ...s, clickSound }))}
            onInternalClickVolume={(v) => setSettings((s) => ({ ...s, internalClickVolume: v }))}
            onInternalClickMute={() => setSettings((s) => ({ ...s, internalClickMute: !s.internalClickMute }))}
            onInternalClickOutput={(out) => setSettings((s) => ({ ...s, internalClickOutput: out }))}
            onAutoGuideVolume={(v) => setSettings((s) => ({ ...s, autoGuideVolume: v, guideEnabled: true, autoGuideMute: false }))}
            onAutoGuideMute={() =>
              setSettings((s) => ({
                ...s,
                guideEnabled: true,
                autoGuideMute: !s.autoGuideMute,
              }))
            }
            onAutoGuideOutput={(out) => setSettings((s) => ({ ...s, autoGuideOutput: out }))}
            onTestAutoGuide={() => {
              const sec =
                song?.sections[curIdx >= 0 ? curIdx : 0] ?? {
                  id: 'test',
                  type: 'REFRAO',
                  label: 'Refrão',
                  start: 0,
                  end: 4,
                };
              speak(sec, false, true);
            }}
            onMasterVolume={(v) => setSettings((s) => ({ ...s, masterVolume: v }))}
            onTrack={(trackId, patch) => {
              if (!song) return;
              updateSong(song.id, (s) => ({
                tracks: s.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)),
              }));
            }}
            onBusGroup={handleBusGroup}
            onSmartRouting={() => setSettings((s) => ({ ...s, smartRouting: !s.smartRouting }))}
            onResetSolo={() =>
              song && updateSong(song.id, (s) => ({ tracks: s.tracks.map((t) => ({ ...t, solo: false, mute: false })) }))
            }
          />
        ) : (
          <PadPanel
            activeKey={padKey}
            songKey={effectiveSongKey}
            volume={settings.padVolume}
            sound={settings.padSound}
            cutoff={settings.padCutoff}
            resonance={settings.padResonance}
            crossfade={settings.padCrossfade}
            banks={settings.padBanks ?? []}
            activeBankId={settings.activePadBankId ?? 'default'}
            onSelectBank={handleSelectPadBank}
            onCreateBank={handleCreatePadBank}
            onRenameBank={handleRenamePadBank}
            onDeleteBank={handleDeletePadBank}
            onAddFilesToBank={handleAddFilesToPadBank}
            customFolderName={settings.customPadFolderName}
            customKeysCount={settings.customPadKeys?.length ?? 0}
            onToggle={togglePad}
            onStop={() => {
              pads.stop();
              setPadKey(null);
            }}
            onVolume={(v) => setSettings((s) => ({ ...s, padVolume: v }))}
            onSound={(snd) => setSettings((s) => ({ ...s, padSound: snd }))}
            onCutoff={(padCutoff) => setSettings((s) => ({ ...s, padCutoff }))}
            onResonance={(padResonance) => setSettings((s) => ({ ...s, padResonance }))}
            onCrossfade={(padCrossfade) => setSettings((s) => ({ ...s, padCrossfade }))}
            onImportFolder={(files) => files && void handleImportPadFolder(files)}
            onOpenFloating={() => setSettings((s) => ({ ...s, floatingPadOpen: !s.floatingPadOpen }))}
          />
        )}
      </section>

      {settings.floatingPadOpen && (
        <FloatingPadWindow
          activeKey={padKey}
          songKey={effectiveSongKey}
          volume={settings.padVolume}
          sound={settings.padSound}
          cutoff={settings.padCutoff}
          resonance={settings.padResonance}
          crossfade={settings.padCrossfade}
          banks={settings.padBanks ?? []}
          activeBankId={settings.activePadBankId ?? 'default'}
          onSelectBank={handleSelectPadBank}
          customFolderName={settings.customPadFolderName}
          customKeysCount={settings.customPadKeys?.length ?? 0}
          onToggle={togglePad}
          onStop={() => {
            pads.stop();
            setPadKey(null);
          }}
          onVolume={(v) => setSettings((s) => ({ ...s, padVolume: v }))}
          onSound={(snd) => setSettings((s) => ({ ...s, padSound: snd }))}
          onCutoff={(padCutoff) => setSettings((s) => ({ ...s, padCutoff }))}
          onResonance={(padResonance) => setSettings((s) => ({ ...s, padResonance }))}
          onCrossfade={(padCrossfade) => setSettings((s) => ({ ...s, padCrossfade }))}
          onImportFolder={(files) => files && void handleImportPadFolder(files)}
          onClose={() => setSettings((s) => ({ ...s, floatingPadOpen: false }))}
        />
      )}

      {dialog === 'pads-drawer' && (
        <PadPanel
          isDrawer
          onClose={() => setDialog(null)}
          activeKey={padKey}
          songKey={effectiveSongKey}
          volume={settings.padVolume}
          sound={settings.padSound}
          cutoff={settings.padCutoff}
          resonance={settings.padResonance}
          crossfade={settings.padCrossfade}
          banks={settings.padBanks ?? []}
          activeBankId={settings.activePadBankId ?? 'default'}
          onSelectBank={handleSelectPadBank}
          onCreateBank={handleCreatePadBank}
          onRenameBank={handleRenamePadBank}
          onDeleteBank={handleDeletePadBank}
          onAddFilesToBank={handleAddFilesToPadBank}
          customFolderName={settings.customPadFolderName}
          customKeysCount={settings.customPadKeys?.length ?? 0}
          onToggle={togglePad}
          onStop={() => {
            pads.stop();
            setPadKey(null);
          }}
          onVolume={(v) => setSettings((s) => ({ ...s, padVolume: v }))}
          onSound={(snd) => setSettings((s) => ({ ...s, padSound: snd }))}
          onCutoff={(padCutoff) => setSettings((s) => ({ ...s, padCutoff }))}
          onResonance={(padResonance) => setSettings((s) => ({ ...s, padResonance }))}
          onCrossfade={(padCrossfade) => setSettings((s) => ({ ...s, padCrossfade }))}
          onImportFolder={(files) => files && void handleImportPadFolder(files)}
          onOpenFloating={() => setSettings((s) => ({ ...s, floatingPadOpen: !s.floatingPadOpen }))}
        />
      )}

      {dialog === 'import' && <ImportDialog ctx={engine.ctx} onClose={() => setDialog(null)} onImported={onImported} />}
      {dialog === 'catalog' && (
        <CatalogDialog
          ctx={engine.ctx}
          repertoireSongs={songs}
          isAdmin={user?.role === 'admin'}
          onOpenAdminPanel={() => setDialog('admin-panel')}
          onClose={() => setDialog(null)}
          onSongImported={(s) => {
            onImported(s);
          }}
        />
      )}
      {dialog === 'admin-panel' && user?.role === 'admin' && (
        <AdminPanelDialog onClose={() => setDialog(null)} />
      )}
      {(!user || dialog === 'auth') && (
        <AuthDialog
          currentUser={user}
          onSuccess={(u) => {
            setUser(u);
            setDialog(null);
          }}
          onLogout={() => {
            authService.logout();
            setUser(null);
          }}
          onClose={() => {
            if (user) setDialog(null);
          }}
          onOpenAdmin={() => setDialog('admin-panel')}
        />
      )}
      {dialog === 'settings' && (
        <SettingsDialog
          settings={settings}
          engine={engine}
          sections={song?.sections}
          onChange={(p) => setSettings((s) => ({ ...s, ...p }))}
          onTestGuideVoice={() => {
            const sec =
              song?.sections[curIdx >= 0 ? curIdx : 0] ?? {
                id: 'test',
                type: 'REFRAO',
                label: 'Refrão',
                start: 0,
                end: 4,
              };
            speak(sec, false, true);
          }}
          onClose={() => setDialog(null)}
          onOpenRemote={() => setDialog('remote')}
          onCheckForUpdates={() => void checkForUpdates(true)}
          isCheckingUpdates={isCheckingUpdates}
        />
      )}
      {dialog === 'edit' && song && (
        <SongEditDialog song={song} pos={engine.position} onSave={onSongEdited} onClose={() => setDialog(null)} />
      )}
      {dialog === 'pitch' && song && (
        <PitchPluginDialog
          song={song}
          onChangeSemitones={setPitchSemitones}
          onUpdateSong={(patch) => updateSong(song.id, patch)}
          onUpdateTrack={(trackId, patch) =>
            updateSong(song.id, (s) => ({ tracks: s.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)) }))
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'ai' && song && (
        <AiAssistantDialog
          song={song}
          buffers={buffersRef.current.get(song.id)}
          geminiApiKey={settings.geminiApiKey}
          onSaveGeminiKey={(geminiApiKey) => setSettings((s) => ({ ...s, geminiApiKey }))}
          onUpdateSong={(patch) => updateSong(song.id, patch)}
          onChangePitchOffset={changePitchOffset}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'midi' && (
        <MidiDialog
          song={song}
          pos={engine.position}
          mappings={settings.midiMappings}
          onChange={(midiMappings) => setSettings((s) => ({ ...s, midiMappings }))}
          onUpdateSong={(patch) => song && updateSong(song.id, patch)}
          onTrigger={triggerMidiMapping}
          onSendMidiOut={sendMidiOutCue}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'library' && (
        <LibraryDrawer
          songs={songs}
          setlists={setlists}
          activeSetlistId={setlist?.id ?? ''}
          onClose={() => setDialog(null)}
          onImport={() => setDialog('import')}
          onOpenCatalog={() => setDialog('catalog')}
          onAddToSetlist={addSongToSetlist}
          onDeleteSong={deleteSong}
          onSelectSetlist={(id) => {
            setActiveSetlistId(id);
            const first = setlists.find((s) => s.id === id)?.songIds[0];
            if (first) {
              void loadSong(first);
            } else {
              unloadActiveSong();
            }
          }}
          onCreateSetlist={(name) => {
            const sl: Setlist = { id: uid('sl'), name, songIds: [] };
            setSetlists((l) => [...l, sl]);
            setActiveSetlistId(sl.id);
            unloadActiveSong();
          }}
          onRenameSetlist={(id, name) => updateSetlist(id, { name })}
          onDeleteSetlist={(id) => {
            if (setlists.length <= 1) return;
            const remaining = setlists.filter((s) => s.id !== id);
            setSetlists(remaining);
            if (id === activeSetlistId) {
              const nextSl = remaining[0];
              setActiveSetlistId(nextSl.id);
              if (nextSl.songIds[0]) void loadSong(nextSl.songIds[0]);
              else unloadActiveSong();
            }
          }}
          onSyncWebSetlists={syncWebSetlists}
        />
      )}

      {dialog === 'remote' && (
        <RemoteControlDialog
          onClose={() => setDialog(null)}
          connectedClients={remoteClientsCount}
        />
      )}
      {dialog === 'waveform' && song && (
        <WaveformTimelineEditor
          song={song}
          engine={engine}
          onSave={(updated) => updateSong(song.id, updated)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'sync-web' && (
        <SyncWebModal
          webPlaylists={syncWebPlaylists}
          localSongs={songs.map((s) => ({ id: s.id, name: s.name }))}
          ctx={engine.ctx}
          onSongImported={handleSyncSongImported}
          onComplete={handleSyncComplete}
          onClose={() => setDialog(null)}
        />
      )}

      {/* Subscription Guard Modal for Delinquent/Expired Accounts */}
      {user && !accessCheck.allowed && (
        <SubscriptionGuardModal
          user={user}
          reason={accessCheck.reason}
          onLogout={() => {
            authService.logout();
            setUser(null);
            setDialog('auth');
          }}
          onUnlocked={() => {
            setSubscriptionVersion((v) => v + 1);
          }}
        />
      )}

      {/* Auto-Updater Modal (Dark Mode) */}
      {updateAvailable && (
        <UpdateDialog
          updateInfo={updateInfo}
          isDownloading={isDownloadingUpdate}
          downloadProgress={updateProgress}
          downloadStatus={updateStatus}
          error={updateError}
          onUpdate={applyUpdate}
          onClose={dismissUpdate}
        />
      )}
    </div>
  );
}
