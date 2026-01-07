import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Settings, X, MousePointer2, 
  Library as LibraryIcon, Plus, BookOpen, Trash2, ChevronLeft,
  Activity, Zap, AlignLeft, AlignRight, CheckCircle2, AlertCircle
} from 'lucide-react';
import * as db from 'idb-keyval';
import JSZip from 'jszip';
import {
  MIN_WPM,
  MAX_WPM,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  RAMP_UP_DURATION_MS,
  REWIND_COUNT,
  INITIAL_SETTINGS,
  DEMO_TEXT
} from './constants';

// -- TYPES --

type BookMeta = {
  id: string;
  title: string;
  wordCount: number;
  progressIndex: number;
  dateAdded: number;
  themeColor?: string; // For the gradient placeholder
};

type ViewState = 'ONBOARDING' | 'LIBRARY' | 'READER';

type AppSettings = {
  cadence: boolean;
  fixation: boolean;
  deadman: boolean;
  autoRev: boolean; // Module G
  southpaw: boolean; // Left-handed mode
};

type LibraryProps = {
  books: BookMeta[];
  onSelect: (book: BookMeta) => void;
  onImport: (files: FileList) => void;
  onDelete: (id: string) => void;
};

// -- CONSTANTS FOR PHYSICS --

const AUTO_REV_DELAY_MS = 2000; // Wait 2s before revving back
const AUTO_REV_DURATION_MS = 3000; // Take 3s to get back to target

// -- UTILS: PARSER --

const cleanText = (text: string): string[] => {
  const stripped = text.replace(/<[^>]*>/g, ' ');
  const lines = stripped.replace(/\n/g, ' \n ');
  return lines.split(/\s+/).filter(w => w.length > 0);
};

const parseFile = async (file: File): Promise<{ title: string; words: string[] }> => {
  const isEpub = file.name.endsWith('.epub');
  
  if (isEpub) {
    try {
      const zip = await JSZip.loadAsync(file);
      let fullText = '';
      const textFiles: JSZip.JSZipObject[] = [];
      zip.forEach((relativePath, zipEntry) => {
        if (relativePath.match(/\.(xhtml|html|xml)$/i) && !relativePath.includes('container.xml')) {
            textFiles.push(zipEntry);
        }
      });
      textFiles.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of textFiles) {
        const content = await entry.async('string');
        fullText += content + ' ';
      }
      return { title: file.name.replace('.epub', ''), words: cleanText(fullText) };
    } catch (e) {
      console.error("EPUB Parse Error", e);
      alert("Could not parse EPUB structure. Falling back to raw text.");
      const text = await file.text();
      return { title: file.name, words: cleanText(text) };
    }
  } else {
    const text = await file.text();
    return { title: file.name.replace(/\.[^/.]+$/, ""), words: cleanText(text) };
  }
};

// -- UTILS: VISUALS --

const getRandomGradient = (id: string) => {
  const colors = [
    'from-blue-900 to-slate-900',
    'from-emerald-900 to-slate-900',
    'from-purple-900 to-slate-900',
    'from-rose-900 to-slate-900',
    'from-amber-900 to-slate-900',
    'from-cyan-900 to-slate-900',
  ];
  // Simple hash to pick a consistent color for the ID
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
};

const getWordWeight = (word: string) => {
  if (!word) return 1;
  const cleanWord = word.replace(/[^a-zA-Z0-9.,!?;:]/g, ''); 
  const lastChar = word.slice(-1);
  if (['.', '!', '?'].includes(lastChar)) return 2.2;
  if ([',', ';', ':'].includes(lastChar)) return 1.5;
  if (cleanWord.length < 4) return 0.8;
  if (cleanWord.length > 8) return 1.1;
  return 1.0;
};

// -- COMPONENTS --

const Toggle = ({ value, onChange, label, subLabel }: { value: boolean, onChange: () => void, label: string, subLabel?: string }) => (
  <div 
    className="flex items-center justify-between py-4 cursor-pointer group select-none border-b border-white/5 last:border-0"
    onClick={(e) => { e.stopPropagation(); onChange(); }}
  >
    <div className="flex flex-col">
      <span className="text-sm font-medium text-white/90 group-hover:text-white transition-colors tracking-wide">
        {label}
      </span>
      {subLabel && <span className="text-[10px] text-white/40 font-mono mt-1">{subLabel}</span>}
    </div>
    <div className={`relative w-11 h-6 rounded-full transition-colors duration-300 ease-out ${value ? 'bg-cyan-500' : 'bg-white/10'}`}>
      <div 
        className={`absolute top-1 left-1 bg-white w-4 h-4 rounded-full shadow-lg transform transition-transform duration-300 cubic-bezier(0.34, 1.56, 0.64, 1) ${value ? 'translate-x-5' : 'translate-x-0'}`} 
      />
    </div>
  </div>
);

// -- ONBOARDING --

const OnboardingOverlay = ({ onComplete }: { onComplete: () => void }) => {
  return (
    <div className="fixed inset-0 z-[100] bg-black/95 backdrop-blur-3xl flex items-center justify-center p-8">
      <div className="max-w-md w-full space-y-12">
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-black tracking-tighter bg-gradient-to-br from-white to-white/40 bg-clip-text text-transparent">
            SYSTEM BOOT
          </h1>
          <p className="text-sm font-mono text-cyan-400/60 tracking-[0.2em] uppercase">Tape Ticker Synesthesia</p>
        </div>

        <div className="space-y-8">
          <div className="flex items-start gap-6">
            <div className="p-4 rounded-2xl bg-white/5 border border-white/10 shrink-0">
              <MousePointer2 className="w-6 h-6 text-cyan-400" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white mb-1">Deadman Interface</h3>
              <p className="text-white/50 text-sm leading-relaxed">
                Press and <strong className="text-white">hold</strong> anywhere to stream text. 
                Lift your finger to pause instantly and rewind for context.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-6">
            <div className="p-4 rounded-2xl bg-white/5 border border-white/10 shrink-0">
              <Activity className="w-6 h-6 text-amber-400" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white mb-1">Analog Cruise Control</h3>
              <p className="text-white/50 text-sm leading-relaxed">
                While holding, drag <strong className="text-white">Left</strong> to brake or <strong className="text-white">Right</strong> to accelerate. 
                Slow down for tricky parts; the engine will auto-rev back to speed.
              </p>
            </div>
          </div>
        </div>

        <button 
          onClick={onComplete}
          className="w-full py-4 bg-cyan-500 hover:bg-cyan-400 text-black font-bold tracking-wide rounded-xl transition-all active:scale-[0.98] shadow-[0_0_30px_-5px_rgba(6,182,212,0.5)]"
        >
          INITIALIZE
        </button>
      </div>
    </div>
  );
};

// -- READER ENGINE --

type ReaderProps = {
  book: BookMeta;
  words: string[];
  settings: AppSettings;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
  onBack: () => void;
  onUpdateProgress: (id: string, index: number) => void;
};

const ReaderView = ({ book, words, settings, setSettings, onBack, onUpdateProgress }: ReaderProps) => {
  // UI State
  const [wordIndex, setWordIndex] = useState(book.progressIndex || 0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [displayWPM, setDisplayWPM] = useState(INITIAL_SETTINGS.wpm); // The number shown on HUD
  const [fontSize, setFontSize] = useState(INITIAL_SETTINGS.fontSize);
  const [isBraking, setIsBraking] = useState(false); // For Amber visual feedback

  // -- Engine Refs --
  // We use refs for the render loop to avoid React render cycle latency
  const engine = useRef({
    isPlaying: false,
    startTime: 0,
    accumulatedTime: 0,
    lastFrameTime: 0,
    wordIndex: book.progressIndex || 0,
    
    // Speed Physics
    targetWPM: INITIAL_SETTINGS.wpm, // The "Cruise Control" set speed
    currentWPM: 0, // The actual instantaneous speed (starts at 0, ramps up)
    
    // Auto-Rev Logic
    isDragging: false,
    lastDragTime: 0,
    dragStartWPM: 0, // What the speed was when drag started
  });

  // Sync React State changes to Engine
  useEffect(() => {
    engine.current.wordIndex = book.progressIndex;
    setWordIndex(book.progressIndex);
  }, [book.id]);

  // -- ANIMATION LOOP --
  const animationFrameId = useRef<number>(0);

  const loop = useCallback((timestamp: number) => {
    const state = engine.current;
    
    if (!state.lastFrameTime) state.lastFrameTime = timestamp;
    const deltaTime = timestamp - state.lastFrameTime;
    state.lastFrameTime = timestamp;

    if (state.isPlaying) {
      // 1. RAMP UP (0 -> Target) on Start
      const elapsed = timestamp - state.startTime;
      const rampProgress = Math.min(elapsed / RAMP_UP_DURATION_MS, 1.0);
      const rampEase = 1 - Math.pow(1 - rampProgress, 4); // EaseOutQuart

      // 2. AUTO-REV LOGIC (Module G)
      // Determine the "Effective Target" for this frame
      let effectiveTarget = state.targetWPM;

      if (settings.autoRev && !state.isDragging && state.targetWPM < state.dragStartWPM) {
        // If we are below our "Cruise Speed" (dragStartWPM stores the 'permanent' speed in this context)
        // Wait for delay
        const timeSinceDrag = timestamp - state.lastDragTime;
        if (timeSinceDrag > AUTO_REV_DELAY_MS) {
            // Revving back up
            const revProgress = Math.min((timeSinceDrag - AUTO_REV_DELAY_MS) / AUTO_REV_DURATION_MS, 1.0);
            const revEase = 1 - Math.pow(1 - revProgress, 3); // Cubic Ease Out
            
            // Interpolate from the low speed back to the high speed
            effectiveTarget = state.targetWPM + (state.dragStartWPM - state.targetWPM) * revEase;
            
            // If we are basically there, snap it
            if (revProgress >= 0.99) {
                state.targetWPM = state.dragStartWPM; // Restore full cruise speed
            }
        }
      }

      // Calculate instantaneous WPM based on Ramp * Target
      // If we are braking, we bypass the ramp logic for the target modification, 
      // but we still want smooth start.
      // Simplify: state.currentWPM is used for timing. 
      // effectiveTarget is where we WANT to be.
      
      let finalWPM = Math.floor(effectiveTarget * rampEase);
      
      state.currentWPM = finalWPM;
      setDisplayWPM(finalWPM);
      
      // Update Braking Visual State (React State update throttled naturally by React batching, but we can debounce if needed)
      // Visual feedback: Amber if we are significantly below our "Cruise Setting" (dragStartWPM)
      const isRevvingOrBraking = state.dragStartWPM > 0 && effectiveTarget < state.dragStartWPM;
      if (isBraking !== isRevvingOrBraking) setIsBraking(isRevvingOrBraking);

      if (state.currentWPM > 0) {
        const currentWord = words[state.wordIndex];
        let msForThisWord = 60000 / state.currentWPM;

        if (settings.cadence) {
           msForThisWord *= getWordWeight(currentWord);
        }

        state.accumulatedTime += deltaTime;

        if (state.accumulatedTime >= msForThisWord) {
          state.accumulatedTime -= msForThisWord;
          const nextIndex = state.wordIndex + 1;
          
          if (nextIndex >= words.length) {
             stopPlayback();
          } else {
             state.wordIndex = nextIndex;
             setWordIndex(nextIndex);
          }
        }
      }
    } else {
      state.lastFrameTime = 0;
      state.currentWPM = 0;
      setDisplayWPM(state.targetWPM); // Show target when stopped
      setIsBraking(false);
    }

    animationFrameId.current = requestAnimationFrame(loop);
  }, [words, settings.cadence, settings.autoRev, isBraking]); 

  useEffect(() => {
    animationFrameId.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animationFrameId.current);
  }, [loop]);

  // -- INTERACTION HANDLERS --

  const stopPlayback = () => {
    const state = engine.current;
    if (!state.isPlaying) return;

    state.isPlaying = false;
    // Rewind
    const newIndex = Math.max(0, state.wordIndex - REWIND_COUNT);
    state.wordIndex = newIndex;
    setWordIndex(newIndex);
    
    // Save progress
    onUpdateProgress(book.id, newIndex);
    setIsPlaying(false);
  };

  const startPlayback = (clientX: number, clientY: number) => {
    const state = engine.current;
    if (state.wordIndex >= words.length - 1) {
        state.wordIndex = 0;
        setWordIndex(0);
    }

    state.isPlaying = true;
    state.startTime = performance.now();
    state.lastFrameTime = performance.now();
    state.accumulatedTime = 0;
    
    // Reset Auto-Rev state
    state.dragStartWPM = state.targetWPM; 
    
    dragRef.current = {
      startX: clientX,
      startY: clientY,
      startWPM: state.targetWPM,
      startFontSize: fontSize
    };
    
    setIsPlaying(true);
  };

  const dragRef = useRef<{ startX: number; startY: number; startWPM: number; startFontSize: number } | null>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (showSettings) return; 
    e.preventDefault();
    if (settings.deadman) {
      startPlayback(e.clientX, e.clientY);
    } else {
      if (engine.current.isPlaying) stopPlayback();
      else startPlayback(e.clientX, e.clientY);
    }
  };

  const handlePointerUp = () => {
    if (settings.deadman) stopPlayback();
    
    // End dragging logic
    const state = engine.current;
    state.isDragging = false;
    state.lastDragTime = performance.now();
    dragRef.current = null;
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const state = engine.current;
    if (!state.isPlaying || !dragRef.current) return;

    state.isDragging = true;
    state.lastDragTime = performance.now(); // Keep resetting delay while moving

    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    
    // WPM Logic
    // Sensitivity: 2px = 1 WPM
    let newWPM = dragRef.current.startWPM + (dx * 2);
    newWPM = Math.min(Math.max(newWPM, MIN_WPM), MAX_WPM);

    // Font Logic
    // Sensitivity: 2px = 1px Font
    let newFont = dragRef.current.startFontSize - (dy * 0.5);
    newFont = Math.min(Math.max(newFont, MIN_FONT_SIZE), MAX_FONT_SIZE);

    setFontSize(Math.round(newFont));

    // LOGIC: If we are speeding up (Right Drag), we commit that to the "Cruise Control" (dragStartWPM)
    // If we are slowing down (Left Drag), we only change targetWPM temporarily (Elastic)
    
    if (newWPM > dragRef.current.startWPM) {
        // Accelerating: Permanent change
        state.targetWPM = Math.round(newWPM);
        state.dragStartWPM = state.targetWPM; // Update the cruise setpoint
    } else {
        // Braking: Temporary change
        state.targetWPM = Math.round(newWPM);
        // Do NOT update dragStartWPM, so it knows where to return to
    }
  };

  // -- RENDER HELPERS --

  const renderWord = (word: string, index: number, isFocused: boolean = true) => {
    if (!word) return null;
    let mainColor = "text-white";
    let glow = "";

    if (settings.fixation && isFocused) {
        const isCapitalized = /^[A-Z]/.test(word);
        if (isCapitalized && index > 0) {
            const prevWord = words[index - 1];
            if (!/[.?!]$/.test(prevWord)) {
                mainColor = "text-cyan-400";
                glow = "drop-shadow-[0_0_15px_rgba(34,211,238,0.5)]";
            }
        }
    }

    // Only apply fixation splitting if focused
    if (!settings.fixation || !isFocused) {
        // Simple render for context words (or if fixation disabled)
        return <span className={`${mainColor} font-medium tracking-tight ${!isFocused ? 'opacity-60' : ''}`}>{word}</span>;
    }

    const splitIndex = Math.ceil(word.length / 2);
    const boldPart = word.slice(0, splitIndex);
    const lightPart = word.slice(splitIndex);

    return (
      <span className={`inline-block tracking-normal ${glow} transition-all duration-200`}>
        <span className={`${mainColor} font-extrabold`}>{boldPart}</span>
        <span className={`${mainColor} font-light opacity-60`}>{lightPart}</span>
      </span>
    );
  };

  const progress = (wordIndex / words.length) * 100;

  return (
    <div 
      className="relative w-full h-screen bg-[#050505] text-white overflow-hidden select-none touch-none"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onPointerMove={handlePointerMove}
    >
      {/* Dynamic Background */}
      <div className="absolute inset-0 bg-gradient-to-br from-indigo-900/10 via-black to-cyan-900/10 animate-pulse-slow pointer-events-none" />
      <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 pointer-events-none mix-blend-overlay" />

      {/* Header Controls (Responsive to Southpaw) */}
      <div className={`absolute top-0 w-full z-50 p-6 flex ${settings.southpaw ? 'flex-row-reverse' : 'flex-row'} justify-between items-start pointer-events-none`}>
         <button 
           className="pointer-events-auto group px-4 py-2 rounded-full bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-all backdrop-blur-2xl border border-white/10 hover:border-white/30 flex items-center gap-2"
           onClick={(e) => { e.stopPropagation(); onBack(); }}
         >
            {settings.southpaw ? null : <ChevronLeft className="w-5 h-5" />}
            <span className="text-xs font-mono uppercase tracking-widest hidden sm:inline">Vault</span>
            {settings.southpaw ? <ChevronLeft className="w-5 h-5 rotate-180" /> : null}
         </button>

         <button 
            className="pointer-events-auto p-3 rounded-full bg-white/5 hover:bg-white/10 text-white/40 hover:text-white transition-all backdrop-blur-2xl border border-white/10 hover:border-white/30"
            onClick={(e) => { e.stopPropagation(); setShowSettings(true); }}
            onPointerDown={(e) => e.stopPropagation()} 
         >
            <Settings className="w-6 h-6" />
         </button>
      </div>

      {/* Reticle & Word Ticker */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        {/* Horizontal Line */}
        <div className="absolute w-full max-w-3xl h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
        
        {/* Vertical Notch (Center) */}
        <div className="absolute h-8 w-px bg-white/20 top-1/2 -translate-y-1/2" />
        
        {/* Fixation Indicator */}
        <div className={`absolute h-16 w-1 rounded-full top-1/2 -translate-y-1/2 transition-colors duration-500 ${isBraking ? 'bg-amber-500/50 blur-sm' : 'bg-red-500/20 blur-[1px]'}`} />

        <div className="relative z-10 w-full flex items-center justify-center gap-8 md:gap-16 px-4">
            {[-2, -1, 0, 1, 2].map(offset => {
                const idx = wordIndex + offset;
                const isCenter = offset === 0;
                // Spacer for out of bounds
                if (idx < 0 || idx >= words.length) return <div key={`spacer-${offset}`} className="w-12 h-1 invisible">Spacer</div>;
                
                const word = words[idx];
                
                // Dynamic styles for the ticker effect
                // Center: Big, Opaque. Neighbors: Smaller, faded.
                // We use em/rem relative to base fontSize
                let scale = isCenter ? 1 : 0.5;
                if (Math.abs(offset) === 1) scale = 0.65;
                
                let opacity = isCenter ? 1 : 0.3;
                if (Math.abs(offset) === 1) opacity = 0.5;
                
                const blur = isCenter ? 'blur-0' : 'blur-[0.5px]';

                return (
                    <div 
                        key={`${idx}-${word}`} // Unique key ensures React replaces the slot, effectively "Moving" the word if we had layout anims, but here creates a stable slot update
                        className={`transition-all duration-150 ease-out flex items-center justify-center ${blur}`}
                        style={{ 
                            fontSize: `${fontSize * scale}px`,
                            opacity: opacity,
                            transform: `scale(${scale})`, // Redundant but safe
                        }}
                    >
                        {renderWord(word, idx, isCenter)}
                    </div>
                );
            })}
        </div>
      </div>

      {/* HUD Stats */}
      <div className={`absolute top-24 sm:top-8 ${settings.southpaw ? 'right-6 text-right' : 'left-6 text-left'} pointer-events-none transition-all duration-300 ${isPlaying ? 'opacity-100' : 'opacity-40'}`}>
        <div className="flex flex-col gap-1">
             <div className="flex items-center gap-2 mb-1">
                {isBraking ? (
                    <AlertCircle className="w-3 h-3 text-amber-500 animate-pulse" />
                ) : (
                    <Zap className="w-3 h-3 text-cyan-500" />
                )}
                <span className="text-[10px] font-mono text-white/30 uppercase tracking-[0.2em]">
                    {isBraking ? 'MANUAL OVR' : 'CRUISE CTRL'}
                </span>
             </div>
             <span className={`text-4xl font-mono font-bold tracking-tighter tabular-nums transition-colors duration-300 ${isBraking ? 'text-amber-400' : 'text-white'}`}>
                {displayWPM}
             </span>
             <span className="text-xs font-mono text-white/30">WPM</span>
        </div>
      </div>

      {/* Deadman Hint */}
      {!isPlaying && !showSettings && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="mt-64 flex flex-col items-center gap-4 opacity-40 animate-pulse-slow">
                <MousePointer2 className="w-6 h-6 text-white/40" />
                <span className="text-xs font-mono tracking-[0.3em] text-white/30 uppercase">
                  {settings.deadman ? "Hold to Engage" : "Tap to Start"}
                </span>
            </div>
        </div>
      )}

      {/* Progress Bar */}
      <div className="absolute bottom-10 left-8 right-8 pointer-events-none">
        <div className="flex justify-between text-[10px] font-mono text-white/30 mb-3 uppercase tracking-widest">
            <span className="truncate max-w-[200px] opacity-70">{book.title}</span>
            <span className="tabular-nums">{Math.floor(progress)}%</span>
        </div>
        <div className="h-[2px] w-full bg-white/5 rounded-full overflow-hidden backdrop-blur-sm">
            <div 
                className={`h-full transition-all duration-100 ease-linear shadow-[0_0_10px_rgba(255,255,255,0.5)] ${isBraking ? 'bg-amber-500' : 'bg-white'}`}
                style={{ width: `${progress}%` }}
            />
        </div>
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div 
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-2xl p-6"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="w-full max-w-md bg-[#111]/90 border border-white/10 rounded-3xl p-8 shadow-2xl relative overflow-hidden">
            <div className="absolute inset-0 bg-white/5 pointer-events-none" />
            
            <div className="relative z-10 flex items-center justify-between mb-8">
                <h2 className="text-xl font-bold font-mono uppercase tracking-widest text-white">Config</h2>
                <button 
                  onClick={() => setShowSettings(false)}
                  className="p-2 bg-white/5 hover:bg-white/10 rounded-full transition-colors border border-white/5"
                >
                  <X className="w-5 h-5 text-white/60" />
                </button>
            </div>
            
            <div className="relative z-10 space-y-1">
              <Toggle 
                label="Cadence Mode" 
                subLabel="Modulates rhythm based on punctuation."
                value={settings.cadence} 
                onChange={() => setSettings(s => ({ ...s, cadence: !s.cadence }))} 
              />
              <Toggle 
                label="Fixation Anchors" 
                subLabel="Highlights optimal character for focus."
                value={settings.fixation} 
                onChange={() => setSettings(s => ({ ...s, fixation: !s.fixation }))} 
              />
              <Toggle 
                label="Auto-Rev Engine" 
                subLabel="Slows for difficult parts, auto-accelerates back."
                value={settings.autoRev} 
                onChange={() => setSettings(s => ({ ...s, autoRev: !s.autoRev }))} 
              />
              <Toggle 
                label="Deadman Switch" 
                subLabel="Safety mechanism. Hold to read, lift to stop."
                value={settings.deadman} 
                onChange={() => setSettings(s => ({ ...s, deadman: !s.deadman }))} 
              />
              <Toggle 
                label="Southpaw Mode" 
                subLabel="Optimizes interface for left-hand usage."
                value={settings.southpaw} 
                onChange={() => setSettings(s => ({ ...s, southpaw: !s.southpaw }))} 
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// -- LIBRARY VIEW --

const LibraryView = ({ books, onSelect, onImport, onDelete }: LibraryProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onImport(e.dataTransfer.files);
    }
  };

  return (
    <div 
      className="min-h-screen bg-[#050505] text-white p-6 md:p-12 font-sans pb-32"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <header className="flex justify-between items-end mb-16 border-b border-white/5 pb-6">
        <div>
           <h1 className="text-4xl font-black tracking-tighter mb-2 text-transparent bg-clip-text bg-gradient-to-br from-white to-white/40">VAULT</h1>
           <p className="text-white/40 text-[10px] font-mono uppercase tracking-[0.3em]">Secure Storage // Local Only</p>
        </div>
        <button 
          onClick={() => fileInputRef.current?.click()}
          className="group flex items-center gap-2 px-6 py-3 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 transition-all hover:border-white/20 active:scale-95"
        >
          <Plus className="w-4 h-4 text-white/70 group-hover:text-cyan-400 transition-colors" />
          <span className="text-xs font-bold tracking-widest uppercase">Add Book</span>
        </button>
        <input 
          type="file" 
          ref={fileInputRef} 
          className="hidden" 
          accept=".txt,.md,.epub"
          onChange={(e) => e.target.files && onImport(e.target.files)}
        />
      </header>

      {books.length === 0 ? (
        <div 
            className="flex flex-col items-center justify-center h-[40vh] border border-dashed border-white/10 rounded-3xl bg-white/[0.02] p-8 text-center hover:bg-white/[0.04] transition-colors cursor-pointer"
            onClick={() => fileInputRef.current?.click()}
        >
            <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-6">
                <BookOpen className="w-8 h-8 text-white/20" />
            </div>
            <p className="text-xl font-bold text-white/60 mb-2">Vault Empty</p>
            <p className="text-sm text-white/30 max-w-xs leading-relaxed">
                Drag and drop EPUB or TXT files here, or tap above to initialize.
            </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {books.map(book => {
            const progress = Math.round((book.progressIndex / book.wordCount) * 100) || 0;
            const gradient = book.themeColor || getRandomGradient(book.id);
            
            return (
              <div 
                key={book.id}
                onClick={() => onSelect(book)}
                className="group relative bg-white/5 backdrop-blur-sm border border-white/5 rounded-3xl p-6 hover:border-white/20 transition-all cursor-pointer hover:bg-white/10 hover:shadow-2xl hover:scale-[1.02] flex flex-col justify-between h-[280px]"
              >
                 <div className={`absolute inset-0 rounded-3xl opacity-0 group-hover:opacity-20 transition-opacity bg-gradient-to-br ${gradient} pointer-events-none`} />
                 
                 <div className="relative z-10">
                    <div className="flex justify-between items-start mb-6">
                        <div className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${gradient} border border-white/10 flex items-center justify-center shadow-inner`}>
                            <span className="font-mono text-[10px] font-bold text-white/70">TXT</span>
                        </div>
                        <button 
                            className="p-3 -mr-3 -mt-3 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all text-white/20 hover:bg-white/10 rounded-full"
                            onClick={(e) => { e.stopPropagation(); onDelete(book.id); }}
                        >
                            <Trash2 className="w-4 h-4" />
                        </button>
                    </div>
                    <h3 className="text-xl font-bold leading-tight line-clamp-3 text-gray-200 group-hover:text-white transition-colors mb-2">
                        {book.title}
                    </h3>
                    <p className="text-[10px] uppercase tracking-widest text-white/40 font-mono">
                        {(book.wordCount / 1000).toFixed(1)}k words
                    </p>
                 </div>

                 <div className="relative z-10 mt-6">
                    <div className="flex justify-between text-[10px] font-mono uppercase tracking-widest text-white/30 mb-2">
                        <span>Read</span>
                        <span>{progress}%</span>
                    </div>
                    <div className="h-1 w-full bg-white/10 rounded-full overflow-hidden">
                        <div 
                            className="h-full bg-cyan-500/80 group-hover:bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.4)] transition-all duration-500" 
                            style={{ width: `${progress}%` }} 
                        />
                    </div>
                 </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// -- MAIN APP CONTROLLER --

export default function App() {
  const [view, setView] = useState<ViewState>('LIBRARY');
  const [library, setLibrary] = useState<BookMeta[]>([]);
  const [activeBookId, setActiveBookId] = useState<string | null>(null);
  const [activeWords, setActiveWords] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  
  // App-Wide Settings
  const [settings, setSettings] = useState<AppSettings>({
    cadence: true,
    fixation: true,
    deadman: true,
    autoRev: true,
    southpaw: false,
  });

  // Load Settings & Library
  useEffect(() => {
    const init = async () => {
        try {
            // Load Settings
            const savedSettings = await db.get<AppSettings>('user_settings');
            if (savedSettings) setSettings(savedSettings);

            // Check Onboarding
            const hasVisited = await db.get<boolean>('has_visited');
            if (!hasVisited) setView('ONBOARDING');

            // Load Library
            const storedLib = await db.get<BookMeta[]>('library');
            if (storedLib) setLibrary(storedLib);
            
            // Default Book
            if (!storedLib || storedLib.length === 0) {
                const demoWords = cleanText(DEMO_TEXT);
                const demoBook: BookMeta = {
                    id: 'demo',
                    title: 'Neuromancer (Excerpt)',
                    wordCount: demoWords.length,
                    progressIndex: 0,
                    dateAdded: Date.now(),
                    themeColor: 'from-cyan-900 to-slate-900'
                };
                await db.set('library', [demoBook]);
                await db.set('content_demo', demoWords);
                setLibrary([demoBook]);
            }
        } catch (e) {
            console.error("Failed to load vault", e);
        } finally {
            setLoading(false);
        }
    };
    init();
  }, []);

  // Save Settings on change
  useEffect(() => {
    if (!loading) {
        db.set('user_settings', settings);
    }
  }, [settings, loading]);

  const handleOnboardingComplete = async () => {
    await db.set('has_visited', true);
    setView('LIBRARY');
  };

  const handleImport = async (files: FileList) => {
    const newBooks: BookMeta[] = [...library];
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
            const { title, words } = await parseFile(file);
            const id = `book_${Date.now()}_${i}`;
            const meta: BookMeta = {
                id,
                title: title || 'Untitled',
                wordCount: words.length,
                progressIndex: 0,
                dateAdded: Date.now(),
                themeColor: getRandomGradient(id)
            };
            await db.set(`content_${id}`, words);
            newBooks.push(meta);
        } catch (e) {
            console.error(`Failed to import ${file.name}`, e);
        }
    }
    await db.set('library', newBooks);
    setLibrary(newBooks);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this book from the vault?")) return;
    const newLib = library.filter(b => b.id !== id);
    setLibrary(newLib);
    await db.set('library', newLib);
    await db.del(`content_${id}`);
  };

  const handleSelectBook = async (book: BookMeta) => {
    try {
        const words = await db.get<string[]>(`content_${book.id}`);
        if (words) {
            setActiveWords(words);
            setActiveBookId(book.id);
            setView('READER');
        } else {
            alert("Error: Book content corrupted.");
        }
    } catch (e) {
        console.error("Error loading book content", e);
    }
  };

  const handleUpdateProgress = useCallback(async (id: string, index: number) => {
    setLibrary(prev => {
        const next = prev.map(b => b.id === id ? { ...b, progressIndex: index } : b);
        db.set('library', next).catch(e => console.error("Save failed", e));
        return next;
    });
  }, []);

  if (loading) return <div className="bg-[#050505] h-screen w-full flex items-center justify-center text-white/20 font-mono tracking-widest animate-pulse">DECRYPTING VAULT...</div>;

  return (
    <>
      {view === 'ONBOARDING' && <OnboardingOverlay onComplete={handleOnboardingComplete} />}
      
      {view === 'LIBRARY' && (
        <LibraryView 
            books={library} 
            onSelect={handleSelectBook} 
            onImport={handleImport} 
            onDelete={handleDelete}
        />
      )}
      
      {view === 'READER' && activeBookId && (
        <ReaderView 
            book={library.find(b => b.id === activeBookId)!} 
            words={activeWords} 
            settings={settings}
            setSettings={setSettings}
            onBack={() => setView('LIBRARY')}
            onUpdateProgress={handleUpdateProgress}
        />
      )}
    </>
  );
}