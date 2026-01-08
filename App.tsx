import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Settings, X, MousePointer2,
  Library as LibraryIcon, Plus, BookOpen, Trash2, ChevronLeft,
  Activity, Zap, AlignLeft, AlignRight, CheckCircle2, AlertCircle, List
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
  chapters: { title: string; startIndex: number }[];
};

type Chapter = {
  title: string;
  startIndex: number;
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

const parseFile = async (file: File): Promise<{ title: string; words: string[]; chapters: Chapter[] }> => {
  const isEpub = file.name.endsWith('.epub');

  if (isEpub) {
    try {
      const zip = await JSZip.loadAsync(file);

      // 1. Find OPF file via container.xml
      const containerParams = await zip.file("META-INF/container.xml")?.async("string");
      if (!containerParams) throw new Error("No container.xml found");

      const parser = new DOMParser();
      const containerDoc = parser.parseFromString(containerParams, "text/xml");
      const rootfile = containerDoc.querySelector("rootfile");
      if (!rootfile) throw new Error("No rootfile in container.xml");

      const opfPath = rootfile.getAttribute("full-path");
      if (!opfPath) throw new Error("No full-path in rootfile");

      // 2. Parse OPF to get Spine and Manifest
      const opfContent = await zip.file(opfPath)?.async("string");
      if (!opfContent) throw new Error("OPF file missing");

      const opfDoc = parser.parseFromString(opfContent, "text/xml");
      const packageTag = opfDoc.querySelector("package");
      const metadata = opfDoc.querySelector("metadata");
      const manifest = opfDoc.querySelector("manifest");
      const spine = opfDoc.querySelector("spine");

      if (!manifest || !spine) throw new Error("Malformed OPF");

      const title = metadata?.querySelector("title")?.textContent || file.name.replace('.epub', '');

      // Map manifest items: id -> href
      const manifestItems: Record<string, string> = {};
      manifest.querySelectorAll("item").forEach(item => {
        const id = item.getAttribute("id");
        const href = item.getAttribute("href");
        if (id && href) manifestItems[id] = href;
      });

      // 3. Process Spine (Reading Order)
      const words: string[] = [];
      const chapters: Chapter[] = [];
      const opfDir = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);

      const spineItems = Array.from(spine.querySelectorAll("itemref"));

      for (const itemRef of spineItems) {
        const idref = itemRef.getAttribute("idref");
        if (!idref || !manifestItems[idref]) continue;

        let href = manifestItems[idref];
        // Resolve path relative to OPF
        // Simple resolution: if href doesn't start with /, append to opfDir
        const fileContentPath = opfDir + href;

        // Handle URL decoding if needed (some epubs have %20)
        // and normalize path separators
        const zipPath = decodeURIComponent(fileContentPath);

        // Find file (ignoring case if possible, but JSZip is case sensitive usually)
        // We'll try exact match first
        let fileData = await zip.file(zipPath)?.async("string");

        // Fallback: try to find file with lax matching if exact fails
        if (!fileData) {
          const foundObj = zip.file(new RegExp(zipPath.replace(/\//g, '\/'), 'i'))[0];
          if (foundObj) fileData = await foundObj.async("string");
        }

        if (fileData) {
          const doc = parser.parseFromString(fileData, "text/html"); // Parsing as HTML handles XHTML well enough usually

          // Extract Title - Prioritize Body Headings over Metadata Title
          let chapterTitle = doc.querySelector("h1")?.textContent ||
            doc.querySelector("h2")?.textContent ||
            doc.querySelector("title")?.textContent;

          if (!chapterTitle) chapterTitle = `Section ${chapters.length + 1}`;

          // Clean Text
          const textContent = doc.body?.textContent || doc.documentElement.textContent || "";
          const clean = cleanText(textContent);

          if (clean.length > 0) {
            chapters.push({
              title: chapterTitle.trim().substring(0, 60), // Limit length
              startIndex: words.length
            });
            words.push(...clean);
          }
        }
      }

      return { title, words, chapters };

    } catch (e) {
      console.error("EPUB Parse Error", e);
      alert("Advanced parsing failed. Falling back to simple mode.");
      const text = await file.text();
      return { title: file.name, words: cleanText(text), chapters: [] };
    }
  } else {
    const text = await file.text();
    return { title: file.name.replace(/\.[^/.]+$/, ""), words: cleanText(text), chapters: [] };
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
    className="flex items-center justify-between py-4 cursor-pointer group select-none border-b border-stone-200 last:border-0"
    onClick={(e) => { e.stopPropagation(); onChange(); }}
  >
    <div className="flex flex-col">
      <span className="text-sm font-serif font-bold text-stone-800 group-hover:text-stone-900 transition-colors tracking-wide">
        {label}
      </span>
      {subLabel && <span className="text-[10px] text-stone-500 font-serif italic mt-1">{subLabel}</span>}
    </div>
    <div className={`relative w-11 h-6 rounded-full transition-colors duration-300 ease-out border border-stone-200 ${value ? 'bg-cyan-600' : 'bg-stone-200'}`}>
      <div
        className={`absolute top-0.5 left-0.5 bg-white w-[18px] h-[18px] rounded-full shadow-sm transform transition-transform duration-300 cubic-bezier(0.34, 1.56, 0.64, 1) ${value ? 'translate-x-5' : 'translate-x-0'}`}
      />
    </div>
  </div>
);

// -- ONBOARDING --

// -- ONBOARDING WIZARD --

const DEMO_SENTENCE = "The sky above the port was the color of television, tuned to a dead channel.";

const OnboardingWizard = ({ onComplete }: { onComplete: () => void }) => {
  const [step, setStep] = useState(0);
  const [localSettings, setLocalSettings] = useState<AppSettings>(INITIAL_SETTINGS);

  // Ticker demo state
  const [demoIndex, setDemoIndex] = useState(0);
  const demoWords = useRef(cleanText(DEMO_SENTENCE)).current;

  useEffect(() => {
    const interval = setInterval(() => {
      setDemoIndex(prev => (prev + 1) % demoWords.length);
    }, 400); // Fixed slow speed for demo
    return () => clearInterval(interval);
  }, [demoWords.length]);

  const nextStep = () => {
    if (step < steps.length - 1) setStep(step + 1);
    else {
      // Save preferences to DB
      db.set('user_settings', localSettings);
      onComplete();
    }
  };

  const toggleSetting = (key: keyof AppSettings) => {
    setLocalSettings(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const steps = [
    {
      title: "Welcome to Synesthesia",
      desc: "A new way to read. Let's personalize your experience.",
      setting: null,
      demo: false
    },
    {
      title: "Fixation Anchors",
      desc: "Bolds the start of words to guide your eye, reducing strain.",
      setting: "fixation",
      demo: true
    },
    {
      title: "Cadence Mode",
      desc: "Slows down for punctuation to create a natural reading rhythm.",
      setting: "cadence",
      demo: true
    },
    {
      title: "Auto-Rev Engine",
      desc: "Automatically returns to your target speed after slowing down.",
      setting: "autoRev",
      demo: false
    },
    {
      title: "Control Scheme",
      desc: "Customize how you interact with the reader.",
      setting: null, // Multiple toggles
      demo: false
    }
  ];

  const currentStep = steps[step];

  return (
    <div className="fixed inset-0 z-[100] bg-[#fdfbf7] flex items-center justify-center p-6">
      {/* Paper Texture */}
      <div className="absolute inset-0 bg-[#e3e0d0] opacity-20 pointer-events-none" />
      <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-60 pointer-events-none mix-blend-multiply" />

      <div className="max-w-xl w-full relative z-10 flex flex-col items-center bg-white border border-stone-200 shadow-2xl rounded-sm p-8 min-h-[500px]">
        {/* Progress Bar */}
        <div className="w-full flex gap-2 mb-8">
          {steps.map((_, i) => (
            <div key={i} className={`h-1 flex-1 rounded-full ${i <= step ? 'bg-stone-800' : 'bg-stone-200'}`} />
          ))}
        </div>

        <div className="text-center space-y-4 mb-8">
          <h2 className="text-3xl font-serif font-black text-stone-900">{currentStep.title}</h2>
          <p className="text-stone-500 font-serif italic">{currentStep.desc}</p>
        </div>

        {/* Dynamic Content Area */}
        <div className={`flex-1 w-full flex flex-col items-center justify-center relative min-h-[160px] ${step === 0 ? 'bg-transparent border-none shadow-none' : 'bg-stone-50 rounded-lg border border-stone-100'} mb-8 overflow-hidden`}>
          {step === 0 ? (
            <div className="text-center space-y-4">
              <div className="w-24 h-24 bg-stone-900 rounded-full flex items-center justify-center mx-auto mb-4 shadow-xl">
                <BookOpen className="w-10 h-10 text-stone-100" />
              </div>
              <p className="text-sm font-serif italic text-stone-600 max-w-xs mx-auto">
                "The book is a machine to think with."
              </p>
            </div>
          ) : currentStep.demo ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <TickerDisplay
                words={demoWords}
                wordIndex={demoIndex}
                fontSize={32}
                isBraking={false}
                settings={localSettings}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-4 w-full px-8">
              {step === 3 && (
                <div className="text-center text-sm text-stone-400 font-serif">
                  (Demonstration requires touch interaction)
                </div>
              )}
              {step === 4 && (
                <>
                  <Toggle
                    label="Deadman Switch"
                    subLabel="Hold to read, release to pause."
                    value={localSettings.deadman}
                    onChange={() => toggleSetting('deadman')}
                  />
                  <Toggle
                    label="Southpaw Mode"
                    subLabel="Inverts UI for left-handed use."
                    value={localSettings.southpaw}
                    onChange={() => toggleSetting('southpaw')}
                  />
                </>
              )}
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="w-full space-y-4">
          {currentStep.setting && (
            <div className="flex justify-center">
              <button
                onClick={() => toggleSetting(currentStep.setting as keyof AppSettings)}
                className={`px-8 py-3 rounded-full border transition-all font-bold tracking-wide ${localSettings[currentStep.setting as keyof AppSettings] ? 'bg-stone-900 text-white border-stone-900' : 'bg-transparent text-stone-500 border-stone-300'}`}
              >
                {localSettings[currentStep.setting as keyof AppSettings] ? 'ENABLED' : 'DISABLED'}
              </button>
            </div>
          )}

          <button
            onClick={nextStep}
            className="w-full py-4 bg-cyan-600 hover:bg-cyan-500 text-white font-serif font-bold tracking-widest uppercase transition-all shadow-lg active:scale-[0.98] mt-4"
          >
            {step === 0 ? "Start Setup" : step === steps.length - 1 ? "Start Reading" : "Continue"}
          </button>
        </div>

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

// -- SHARED COMPONENTS --

const TickerDisplay = ({
  words,
  wordIndex,
  fontSize,
  isBraking,
  settings
}: {
  words: string[],
  wordIndex: number,
  fontSize: number,
  isBraking: boolean,
  settings: AppSettings
}) => {

  const renderWord = (word: string, index: number, isFocused: boolean = true) => {
    if (!word) return null;
    let mainColor = "text-stone-900"; // Dark Ink
    let glow = "";

    if (settings.fixation && isFocused) {
      const isCapitalized = /^[A-Z]/.test(word);
      if (isCapitalized && index > 0) {
        const prevWord = words[index - 1];
        if (!/[.?!]$/.test(prevWord)) {
          mainColor = "text-cyan-600"; // Slightly darker cyan for print feel
          glow = ""; // No glow on paper
        }
      }
    }

    // Only apply fixation splitting if focused
    if (!settings.fixation || !isFocused) {
      return <span className={`${mainColor} font-serif tracking-tight ${!isFocused ? 'opacity-40' : ''}`}>{word}</span>;
    }

    const splitIndex = Math.ceil(word.length / 2);
    const boldPart = word.slice(0, splitIndex);
    const lightPart = word.slice(splitIndex);

    return (
      <span className={`inline-block tracking-normal ${glow} transition-all duration-200 font-serif`}>
        <span className={`${mainColor} font-black`}>{boldPart}</span>
        <span className={`${mainColor} font-medium opacity-80`}>{lightPart}</span>
      </span>
    );
  };

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      {/* Horizontal Guide Line (Subtle Pencil Line) */}
      <div className="absolute w-full max-w-3xl h-px bg-stone-900/5" />

      {/* Vertical Notch (Center) */}
      <div className="absolute h-4 w-px bg-stone-900/10 top-1/2 -translate-y-1/2" />

      {/* Focus Highlight (Subtle Highlight Marker) */}
      <div className={`absolute h-12 w-1 rounded-full top-1/2 -translate-y-1/2 transition-colors duration-500 ${isBraking ? 'bg-amber-400/30' : 'bg-transparent'}`} />

      <div className="relative z-10 w-full flex items-center justify-center gap-8 md:gap-16 px-4">
        {[-2, -1, 0, 1, 2].map(offset => {
          const idx = wordIndex + offset;
          const isCenter = offset === 0;
          // Spacer for out of bounds
          if (idx < 0 || idx >= words.length) return <div key={`spacer-${offset}`} className="w-12 h-1 invisible">Space</div>;

          const word = words[idx];

          // Ticker Logic: Paperback Flow
          // Less aggressive scaling for a "reading line" feel
          let scale = isCenter ? 1 : 0.85; // Flattens the curve
          let opacity = isCenter ? 1 : 0.4;

          return (
            <div
              key={`${idx}-${word}`}
              className={`transition-all duration-200 ease-out flex items-center justify-center`}
              style={{
                fontSize: `${fontSize * scale}px`,
                opacity: opacity,
              }}
            >
              {renderWord(word, idx, isCenter)}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const ReaderView = ({ book, words, settings, setSettings, onBack, onUpdateProgress }: ReaderProps) => {
  // UI State
  const [wordIndex, setWordIndex] = useState(book.progressIndex || 0);
  const [isPlaying, setIsPlaying] = useState(false);

  const [showSettings, setShowSettings] = useState(false);
  const [showChapters, setShowChapters] = useState(false);
  const [displayWPM, setDisplayWPM] = useState(INITIAL_SETTINGS.wpm); // The number shown on HUD
  const [fontSize, setFontSize] = useState(INITIAL_SETTINGS.fontSize);
  const [isBraking, setIsBraking] = useState(false); // For Amber visual feedback

  // Computed: Current Chapter
  const currentChapter = book.chapters.length > 0
    ? book.chapters.slice().reverse().find(c => c.startIndex <= wordIndex)
    : null;

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

  const progress = (wordIndex / words.length) * 100;

  return (
    <div
      className="relative w-full h-screen bg-[#f9f7f1] text-stone-900 overflow-hidden select-none touch-none"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onPointerMove={handlePointerMove}
    >
      {/* Paper Texture & Grain */}
      <div className="absolute inset-0 bg-[#e3e0d0] opacity-10 pointer-events-none" />
      <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-60 pointer-events-none mix-blend-multiply" />

      {/* Subtle Vignette */}
      <div className="absolute inset-0 bg-gradient-radial from-transparent via-transparent to-stone-400/20 pointer-events-none" />

      {/* Header Controls */}
      <div className={`absolute top-0 w-full z-50 p-6 flex ${settings.southpaw ? 'flex-row-reverse' : 'flex-row'} justify-between items-start pointer-events-none`}>
        <button
          className="pointer-events-auto group px-4 py-2 rounded-full bg-stone-900/5 hover:bg-stone-900/10 text-stone-600 hover:text-stone-900 transition-all border border-stone-900/5 hover:border-stone-900/20 flex items-center gap-2"
          onClick={(e) => { e.stopPropagation(); onBack(); }}
        >
          {settings.southpaw ? null : <ChevronLeft className="w-5 h-5" />}
          <span className="text-xs font-serif italic tracking-widest hidden sm:inline">Library</span>
          {settings.southpaw ? <ChevronLeft className="w-5 h-5 rotate-180" /> : null}
        </button>

        <div className="flex items-center gap-2 pointer-events-auto">
          {book.chapters.length > 0 && (
            <button
              className="p-3 rounded-full bg-stone-900/5 hover:bg-stone-900/10 text-stone-600 hover:text-stone-900 transition-all border border-stone-900/5 hover:border-stone-900/20"
              onClick={(e) => { e.stopPropagation(); setShowChapters(true); }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <List className="w-6 h-6" />
            </button>
          )}

          <button
            className="pointer-events-auto p-3 rounded-full bg-stone-900/5 hover:bg-stone-900/10 text-stone-600 hover:text-stone-900 transition-all border border-stone-900/5 hover:border-stone-900/20"
            onClick={(e) => { e.stopPropagation(); setShowSettings(true); }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Settings className="w-6 h-6" />
          </button>
        </div>
      </div>

      {/* Reticle & Word Ticker */}
      <TickerDisplay
        words={words}
        wordIndex={wordIndex}
        fontSize={fontSize}
        isBraking={isBraking}
        settings={settings}
      />

      {/* HUD Stats */}
      <div className={`absolute top-24 sm:top-8 ${settings.southpaw ? 'right-6 text-right' : 'left-6 text-left'} pointer-events-none transition-all duration-300 ${isPlaying ? 'opacity-100' : 'opacity-40'}`}>
        <div className="flex flex-col gap-1 text-stone-900">
          <div className="flex items-center gap-2 mb-1 justify-end sm:justify-start">
            <div className={`w-2 h-2 rounded-full ${isBraking ? 'bg-amber-500' : 'bg-stone-400'}`} />
            <span className="text-[10px] font-serif italic text-stone-400">
              {isBraking ? 'Speed Adjusted' : 'Cruising'}
            </span>
          </div>
          <span className={`text-4xl font-serif font-bold tracking-tighter tabular-nums transition-colors duration-300 ${isBraking ? 'text-amber-600' : 'text-stone-900'}`}>
            {displayWPM}
          </span>
          <span className="text-xs font-serif italic text-stone-400">wpm</span>
          {currentChapter && (
            <div className="mt-4 max-w-[200px]">
              <p className="text-[10px] font-bold text-stone-900 uppercase tracking-widest opacity-40 mb-1">Chapter</p>
              <p className="text-sm font-serif italic text-stone-600 leading-tight">{currentChapter.title}</p>
            </div>
          )}
        </div>
      </div>

      {/* Deadman Hint */}
      {
        !isPlaying && !showSettings && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="mt-64 flex flex-col items-center gap-4 opacity-40 animate-pulse-slow">
              <MousePointer2 className="w-6 h-6 text-stone-400" />
              <span className="text-xs font-serif italic text-stone-400">
                {settings.deadman ? "Touch & Hold to Read" : "Tap to Begin"}
              </span>
            </div>
          </div>
        )
      }

      {/* Progress Bar (Ink Style) */}
      <div className="absolute bottom-10 left-8 right-8 pointer-events-none">
        <div className="flex justify-between text-[11px] font-serif text-stone-400 mb-3 tracking-widest">
          <span className="truncate max-w-[200px] text-stone-600 italic">{book.title}</span>
          <span className="tabular-nums font-bold text-stone-600">{Math.floor(progress)}%</span>
        </div>
        <div className="h-[3px] w-full bg-stone-900/5 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-100 ease-linear ${isBraking ? 'bg-amber-500' : 'bg-stone-800'}`}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Settings Modal (Light Theme) */}
      {
        showSettings && (
          <div
            className="absolute inset-0 z-50 flex items-center justify-center bg-stone-900/20 backdrop-blur-sm p-6"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="w-full max-w-md bg-[#fcfbf9] border border-stone-200 rounded-sm shadow-xl p-8 relative overflow-hidden">
              {/* Spine accent */}
              <div className="absolute left-0 top-0 bottom-0 w-1 bg-red-800/80" />

              <div className="relative z-10 flex items-center justify-between mb-8 pl-4">
                <h2 className="text-2xl font-serif font-bold text-stone-900">Preferences</h2>
                <button
                  onClick={() => setShowSettings(false)}
                  className="p-2 hover:bg-stone-100 rounded-full transition-colors"
                >
                  <X className="w-5 h-5 text-stone-500" />
                </button>
              </div>

              <div className="relative z-10 space-y-1 pl-4">
                <Toggle
                  label="Cadence Mode"
                  subLabel="Slows for punctuation."
                  value={settings.cadence}
                  onChange={() => setSettings(s => ({ ...s, cadence: !s.cadence }))}
                />
                <Toggle
                  label="Fixation Anchor"
                  subLabel="Bold leads for focus."
                  value={settings.fixation}
                  onChange={() => setSettings(s => ({ ...s, fixation: !s.fixation }))}
                />
                <Toggle
                  label="Auto-Rev Engine"
                  subLabel="Adaptive speed control."
                  value={settings.autoRev}
                  onChange={() => setSettings(s => ({ ...s, autoRev: !s.autoRev }))}
                />
                <Toggle
                  label="Deadman Switch"
                  subLabel="Hold to read interaction."
                  value={settings.deadman}
                  onChange={() => setSettings(s => ({ ...s, deadman: !s.deadman }))}
                />
                <Toggle
                  label="Southpaw Mode"
                  subLabel="Left-handed interface."
                  value={settings.southpaw}
                  onChange={() => setSettings(s => ({ ...s, southpaw: !s.southpaw }))}
                />
              </div>
            </div>
          </div>
        )
      }

      {/* Chapters Modal */}
      {
        showChapters && (
          <div
            className="absolute inset-0 z-50 flex items-center justify-center bg-stone-900/20 backdrop-blur-sm p-6"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="w-full max-w-md bg-[#fcfbf9] border border-stone-200 rounded-sm shadow-xl flex flex-col max-h-[80vh] relative overflow-hidden">
              {/* Spine accent */}
              <div className="absolute left-0 top-0 bottom-0 w-1 bg-cyan-800/80" />

              <div className="flex items-center justify-between p-6 border-b border-stone-100 pl-8">
                <h2 className="text-2xl font-serif font-bold text-stone-900">Contents</h2>
                <button
                  onClick={() => setShowChapters(false)}
                  className="p-2 hover:bg-stone-100 rounded-full transition-colors"
                >
                  <X className="w-5 h-5 text-stone-500" />
                </button>
              </div>

              <div className="overflow-y-auto p-2 pl-6">
                {book.chapters.map((chapter, i) => {
                  const isActive = currentChapter === chapter;
                  return (
                    <button
                      key={i}
                      className={`w-full text-left p-4 rounded-lg transition-all group ${isActive ? 'bg-stone-100' : 'hover:bg-stone-50'}`}
                      onClick={() => {
                        setWordIndex(chapter.startIndex);
                        engine.current.wordIndex = chapter.startIndex;
                        engine.current.isPlaying = false; // Pause on jump
                        setIsPlaying(false);
                        setShowChapters(false);
                        onUpdateProgress(book.id, chapter.startIndex);
                      }}
                    >
                      <div className="flex justify-between items-baseline mb-1">
                        <span className={`font-serif text-lg leading-tight ${isActive ? 'font-bold text-stone-900' : 'text-stone-700 group-hover:text-stone-900'}`}>
                          {chapter.title}
                        </span>
                        <span className="text-xs font-mono text-stone-400">
                          {Math.floor((chapter.startIndex / words.length) * 100)}%
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )
      }
    </div >
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
      className="min-h-screen bg-[#f9f7f1] text-stone-900 p-6 md:p-12 font-serif pb-32"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Paper Texture */}
      <div className="fixed inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-40 pointer-events-none mix-blend-multiply" />
      <div className="fixed inset-0 bg-stone-500/5 pointer-events-none" />

      <header className="relative z-10 flex justify-between items-end mb-16 border-b-2 border-stone-900/10 pb-6">
        <div>
          <h1 className="text-5xl font-black tracking-tight mb-2 text-stone-900">Library</h1>
          <p className="text-stone-500 text-xs font-serif italic tracking-widest">Local Storage // Synesthesia</p>
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="group flex items-center gap-2 px-6 py-3 rounded-full bg-stone-900 hover:bg-stone-800 text-[#f9f7f1] transition-all shadow-lg hover:shadow-xl active:scale-95"
        >
          <Plus className="w-4 h-4 text-stone-300 group-hover:text-white transition-colors" />
          <span className="text-xs font-bold tracking-widest uppercase">Add Text</span>
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
          className="relative z-10 flex flex-col items-center justify-center h-[40vh] border-2 border-dashed border-stone-300 rounded-lg bg-white/50 p-8 text-center hover:bg-white/80 transition-colors cursor-pointer"
          onClick={() => fileInputRef.current?.click()}
        >
          <div className="w-16 h-16 rounded-full bg-stone-200 flex items-center justify-center mb-6">
            <BookOpen className="w-8 h-8 text-stone-500" />
          </div>
          <p className="text-xl font-bold text-stone-700 mb-2 font-serif">Vault Empty</p>
          <p className="text-sm text-stone-500 max-w-xs leading-relaxed italic">
            Drag and drop EPUB or TXT files here to begin reading.
          </p>
        </div>
      ) : (
        <div className="relative z-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
          {books.map(book => {
            const progress = Math.round((book.progressIndex / book.wordCount) * 100) || 0;
            const gradient = book.themeColor || getRandomGradient(book.id);

            return (
              <div
                key={book.id}
                onClick={() => onSelect(book)}
                className="group relative bg-white border border-stone-200 rounded-sm p-8 shadow-sm hover:shadow-2xl hover:-translate-y-1 transition-all cursor-pointer flex flex-col justify-between h-[320px] overflow-hidden"
              >
                {/* Book Spine Effect */}
                <div className="absolute left-0 top-0 bottom-0 w-2 bg-stone-900/5 group-hover:bg-red-800 transition-colors" />

                <div className="relative z-10 pl-4">
                  <div className="flex justify-between items-start mb-8">
                    <div className={`w-12 h-12 rounded-full bg-stone-100 border border-stone-200 flex items-center justify-center`}>
                      <span className="font-serif italic text-xs font-bold text-stone-500">Vol.</span>
                    </div>
                    <button
                      className="p-3 -mr-3 -mt-3 opacity-0 group-hover:opacity-100 hover:text-red-600 transition-all text-stone-300 hover:bg-stone-50 rounded-full"
                      onClick={(e) => { e.stopPropagation(); onDelete(book.id); }}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <h3 className="text-2xl font-serif font-bold leading-tight line-clamp-3 text-stone-900 mb-2 selection:bg-stone-200">
                    {book.title}
                  </h3>
                  <p className="text-[10px] uppercase tracking-widest text-stone-400 font-sans font-bold">
                    {(book.wordCount / 1000).toFixed(1)}k words
                  </p>
                </div>

                <div className="relative z-10 mt-6 pl-4">
                  <div className="flex justify-between text-[10px] font-serif italic text-stone-400 mb-2">
                    <span>Progress</span>
                    <span>{progress}%</span>
                  </div>
                  <div className="h-1 w-full bg-stone-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-stone-900 group-hover:bg-red-800 transition-colors duration-500"
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
            themeColor: 'from-cyan-900 to-slate-900',
            chapters: []
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
        const { title, words, chapters } = await parseFile(file);
        const id = `book_${Date.now()}_${i}`;
        const meta: BookMeta = {
          id,
          title: title || 'Untitled',
          wordCount: words.length,
          progressIndex: 0,
          dateAdded: Date.now(),
          themeColor: getRandomGradient(id),
          chapters: chapters || []
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

  if (loading) return (
    <div className="bg-[#f9f7f1] h-screen w-full flex items-center justify-center relative overflow-hidden">
      <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-40 pointer-events-none mix-blend-multiply" />
      <span className="text-stone-400 font-serif italic tracking-widest animate-pulse relative z-10">OPENING VAULT...</span>
    </div>
  );

  return (
    <>
      {view === 'ONBOARDING' && <OnboardingWizard onComplete={handleOnboardingComplete} />}

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