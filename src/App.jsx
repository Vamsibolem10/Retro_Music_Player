import { useState, useRef, useEffect } from 'react'
import ReactPlayer from 'react-player';
import { db, storage } from './firebase';
import { collection, onSnapshot, query, orderBy, addDoc, deleteDoc, doc, updateDoc } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';

const palette = ['#e67e22', '#3498db', '#e74c3c', '#2ecc71', '#9b59b6', '#f1c40f'];

function App() {
  const [library, setLibrary] = useState([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSynced, setIsSynced] = useState(false);
  
  // INITIALIZE GLOBAL REALTIME SIGNAL
  useEffect(() => {
    // SIGNAL PROBE
    console.log("ENGINE STATUS: Connecting to Project Index // " + db.app.options.projectId);

    const q = query(collection(db, 'vault_library'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(d => {
        const item = d.data();
        return { 
          ...item, 
          id: d.id,
          createdAt: item.createdAt?.seconds ? new Date(item.createdAt.seconds * 1000) : item.createdAt 
        };
      });
      setLibrary(data);
      setIsSynced(true);
    }, (error) => {
      console.error("Master Cloud Sync Error (Permission Signal Missing?):", error);
      setIsSynced(false);
    });
    return () => unsubscribe();
  }, []);


  const [elapsed, setElapsed] = useState(0);
  const [modalMode, setModalMode] = useState(null); // 'tape', 'collection', 'song'
  const [editTarget, setEditTarget] = useState(null); 
  const [playSrc, setPlaySrc] = useState(null);
  
  const [selectedCollection, setSelectedCollection] = useState(null);
  const [selectedTape, setSelectedTape] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [animatingTape, setAnimatingTape] = useState(null);
  
  const [volume, setVolume] = useState(0.8);
  const [gain, setGain] = useState(1.0);
  const [bass, setBass] = useState(0);
  const [mid, setMid] = useState(0);
  const [treble, setTreble] = useState(0);
  const [hissVal, setHissVal] = useState(0.05);
  const [eqMode, setEqMode] = useState('Normal');

  const [isVintage, setIsVintage] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordedFile, setRecordedFile] = useState(null);
  const [sortBy, setSortBy] = useState('newest');
  
  const playerRef = useRef(null);
  const nativeAudioRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyzerRef = useRef(null);
  const hissNodeRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const filtersRef = useRef({});
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  const EQ_MODES = {
    'Normal': { bass: 0, mid: 0, treble: 0 },
    'Rock': { bass: 6, mid: -2, treble: 4 },
    'Pop': { bass: -2, mid: 4, treble: 2 },
    'Jazz': { bass: 4, mid: 2, treble: -2 },
    'Electronic': { bass: 8, mid: 0, treble: 6 },
    'Voice': { bass: -6, mid: 8, treble: -4 }
  };

  const cycleMode = () => {
    const modes = Object.keys(EQ_MODES);
    const nextIdx = (modes.indexOf(eqMode) + 1) % modes.length;
    const nextMode = modes[nextIdx];
    setEqMode(nextMode);
    setBass(EQ_MODES[nextMode].bass);
    setMid(EQ_MODES[nextMode].mid);
    setTreble(EQ_MODES[nextMode].treble);
  };

  // Initialize Lo-Fi Effects
  useEffect(() => {
    if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    
    // Tape Hiss Generator
    const bufferSize = 2 * audioContextRef.current.sampleRate;
    const noiseBuffer = audioContextRef.current.createBuffer(1, bufferSize, audioContextRef.current.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
    }
    
    const noise = audioContextRef.current.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;
    
    const noiseFilter = audioContextRef.current.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.value = 1200; // Muffled hiss
    
    hissNodeRef.current = audioContextRef.current.createGain();
    hissNodeRef.current.gain.value = 0;
    
    noise.connect(noiseFilter);
    noiseFilter.connect(hissNodeRef.current);
    hissNodeRef.current.connect(audioContextRef.current.destination);
    
    noise.start();
    
    return () => {
        noise.stop();
    };
  }, []);

  useEffect(() => {
    if (hissNodeRef.current && audioContextRef.current) {
        hissNodeRef.current.gain.setTargetAtTime(isVintage && isPlaying ? 0.05 : 0, audioContextRef.current.currentTime, 0.2);
    }
  }, [isVintage, isPlaying]);

  const timeString = `${Math.floor(elapsed / 60)}:${Math.floor(elapsed % 60).toString().padStart(2, '0')}`;
  
  const activeTrack = activeIdx >= 0 && activeIdx < library.length ? library[activeIdx] : null;


  useEffect(() => {
    let timer;
    if (isPlaying) {
      timer = setInterval(() => {
        setElapsed(prev => prev + 1);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [isPlaying]);

  useEffect(() => {
     if (nativeAudioRef.current) nativeAudioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
     if (nativeAudioRef.current) nativeAudioRef.current.playbackRate = gain;
  }, [gain]);

  useEffect(() => {
    if (nativeAudioRef.current) {
        if (isPlaying && playSrc) {
            // Initialize AudioContext on first play
            if (!audioContextRef.current) {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                audioContextRef.current = new AudioContext();
                
                const source = audioContextRef.current.createMediaElementSource(nativeAudioRef.current);
                sourceNodeRef.current = source;

                const analyzer = audioContextRef.current.createAnalyser();
                analyzer.fftSize = 256;
                analyzerRef.current = analyzer;

                // Tape Hiss Loop
                const hiss = audioContextRef.current.createGain();
                hiss.gain.value = 0;
                hissNodeRef.current = hiss;

                const bufferSize = 2 * audioContextRef.current.sampleRate;
                const buffer = audioContextRef.current.createBuffer(1, bufferSize, audioContextRef.current.sampleRate);
                const out = buffer.getChannelData(0);
                for (let i = 0; i < bufferSize; i++) {
                    out[i] = Math.random() * 2 - 1;
                }
                const whiteNoise = audioContextRef.current.createBufferSource();
                whiteNoise.buffer = buffer;
                whiteNoise.loop = true;
                whiteNoise.start();
                whiteNoise.connect(hiss);

                const bassFilter = audioContextRef.current.createBiquadFilter();
                bassFilter.type = 'lowshelf';
                bassFilter.frequency.value = 200;

                const midFilter = audioContextRef.current.createBiquadFilter();
                midFilter.type = 'peaking';
                midFilter.frequency.value = 1000;
                midFilter.Q.value = 1;

                const trebleFilter = audioContextRef.current.createBiquadFilter();
                trebleFilter.type = 'highshelf';
                trebleFilter.frequency.value = 3000;

                filtersRef.current = { bass: bassFilter, mid: midFilter, treble: trebleFilter };

                source.connect(bassFilter);
                bassFilter.connect(midFilter);
                midFilter.connect(trebleFilter);
                trebleFilter.connect(analyzer);
                hiss.connect(analyzer);
                analyzer.connect(audioContextRef.current.destination);
            }

            // High-Fidelity Autoplay Wake-up
            if (audioContextRef.current?.state === 'suspended') {
                audioContextRef.current.resume();
            }

            const p = nativeAudioRef.current.play();
            if (p !== undefined) p.catch(e => console.error("Native play error:", e));
        } else {
            nativeAudioRef.current.pause();
        }
    }
  }, [isPlaying, playSrc]);


  useEffect(() => {
    if (hissNodeRef.current) hissNodeRef.current.gain.value = isPlaying ? hissVal : 0;
  }, [hissVal, isPlaying]);

  useEffect(() => {
    if (filtersRef.current.bass) filtersRef.current.bass.gain.value = bass;
  }, [bass]);

  useEffect(() => {
    if (filtersRef.current.mid) filtersRef.current.mid.gain.value = mid;
  }, [mid]);

  useEffect(() => {
    if (filtersRef.current.treble) filtersRef.current.treble.gain.value = treble;
  }, [treble]);

  const startTrack = (idx, e) => {
    // If an event is provided, trigger the physical insertion animation
    if (e && e.currentTarget) {
        const rect = e.currentTarget.getBoundingClientRect();
        const deckRect = document.querySelector('.deck-display').getBoundingClientRect();
        
        const tx = deckRect.left + (deckRect.width/2) - (rect.left + rect.width/2);
        const ty = deckRect.top + (deckRect.height/2) - (rect.top + rect.height/2);

        setAnimatingTape({
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
            color: library[idx].color || '#e67e22',
            title: library[idx].tape,
            collection: library[idx].collection,
            tx, ty
        });

        setTimeout(() => {
            setAnimatingTape(null);
            finalizeTrackStart(idx);
        }, 700);
    } else {
        finalizeTrackStart(idx);
    }
  };

  const ejectTape = () => {
    if (!activeTrack) return;
    
    // Find the deck-display element
    const deckElem = document.querySelector('.deck-display');
    if (deckElem) {
        const rect = deckElem.getBoundingClientRect();
        
        setAnimatingTape({
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
            color: activeTrack.color || '#e67e22',
            title: activeTrack.title,
            collection: activeTrack.collection || 'ARCHIVE',
            tx: -300, 
            ty: 400,
            isEjecting: true
        });

        // HIDE STATIC TAPE IMMEDIATELY
        setIsPlaying(false);
        setActiveIdx(null); // This clears the static player visual

        setTimeout(() => {
            setAnimatingTape(null);
            fullStop();
        }, 600);
    } else {
        stopTrack();
    }
  };

  const finalizeTrackStart = (idx) => {
    setActiveIdx(idx);
    setElapsed(0);
    const track = library[idx];
    if (!track || track.type === 'stub') return;
    
    let actualSrc = track.src;
    // Fallback for legacy items stuck in blob mode
    if (track.type === 'file' && track.fileObj && !track.src) {
        try {
           actualSrc = URL.createObjectURL(track.fileObj);
        } catch(e) {}
    }
    
    setPlaySrc(actualSrc);
    setIsPlaying(true);
  };

  const toggleRecord = async () => {
    if (isRecording) {
      if (mediaRecorderRef.current) mediaRecorderRef.current.stop();
      setIsRecording(false);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;
        audioChunksRef.current = [];
        mediaRecorder.ondataavailable = event => { if (event.data.size > 0) audioChunksRef.current.push(event.data); };
        mediaRecorder.onstop = () => {
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          const reader = new FileReader();
          reader.onloadend = () => {
              setRecordedFile(reader.result); // Pass base64 safely
              setModalMode('song');
              stream.getTracks().forEach(track => track.stop());
          };
          reader.readAsDataURL(audioBlob);
        };
        mediaRecorder.start();
        setIsRecording(true);
      } catch (err) {
        console.error('Error accessing mic:', err);
        alert('Could not access microphone for live recording.');
      }
    }
  };

  const togglePlay = () => {
    if (activeIdx === -1 && library.length > 0) {
      const firstPlayable = library.findIndex(t => t.type !== 'stub');
      if (firstPlayable !== -1) startTrack(firstPlayable);
      return;
    }
    setIsPlaying(true);
  };

  const pauseTrack = () => {
    setIsPlaying(false);
  };

  const stopTrack = () => {
    setIsPlaying(false);
    setElapsed(0);
    // Safety reset with feature detection
    try {
        if (playerRef.current && typeof playerRef.current.seekTo === 'function') {
            playerRef.current.seekTo(0);
        }
    } catch(e) {}
    try { 
        if (nativeAudioRef.current) {
            nativeAudioRef.current.pause();
            nativeAudioRef.current.currentTime = 0; 
        }
    } catch(e) {}
  };

  const fullStop = () => {
    stopTrack();
    setActiveIdx(null);
    setPlaySrc(null);
  };

  const rewind = () => {
    if (nativeAudioRef.current) nativeAudioRef.current.currentTime = Math.max(0, nativeAudioRef.current.currentTime - 10);
    if (playerRef.current) {
        const cur = playerRef.current.getCurrentTime();
        playerRef.current.seekTo(Math.max(0, cur - 10));
    }
    setElapsed(prev => Math.max(0, prev - 10));
  };

  const fastForward = () => {
    if (nativeAudioRef.current) nativeAudioRef.current.currentTime += 10;
    if (playerRef.current) {
        const cur = playerRef.current.getCurrentTime();
        playerRef.current.seekTo(cur + 10);
    }
    setElapsed(prev => prev + 10);
  };

  const nextTrack = () => {
    if (library.length > 0) {
      let next = (activeIdx + 1) % library.length;
      let count = 0;
      while(library[next].type === 'stub' && count < library.length) {
          next = (next + 1) % library.length;
          count++;
      }
      if (library[next].type !== 'stub') startTrack(next);
    }
  };

  const prevTrack = () => {
    if (library.length > 0) {
      let next = (activeIdx - 1 + library.length) % library.length;
      let count = 0;
      while(library[next].type === 'stub' && count < library.length) {
          next = (next - 1 + library.length) % library.length;
          count++;
      }
      if (library[next].type !== 'stub') startTrack(next);
    }
  };

  let uniqueCollectionsMap = {};
  let uniqueTapesMap = {};

   let filteredLib = library;
   if (searchTerm) {
       const low = searchTerm.toLowerCase();
       filteredLib = filteredLib.filter(t => 
           t.title?.toLowerCase().includes(low) || 
           t.artist?.toLowerCase().includes(low) || 
           t.collection?.toLowerCase().includes(low) || 
           t.tape?.toLowerCase().includes(low)
       );
   }

   filteredLib.forEach(t => {
      const cName = t.collection || 'General';
      if (!uniqueCollectionsMap[cName]) {
          uniqueCollectionsMap[cName] = { name: cName, tapes: new Set(), trackCount: 0 };
      }

      if (t.stubType && t.stubType === 'collection') {
          // Collection folder stub
      } else {
          const tName = t.tape || 'Main Tape';
          uniqueCollectionsMap[cName].tapes.add(tName);
          
          const tapeId = `${cName}::${tName}`;
          if (!uniqueTapesMap[tapeId]) {
             uniqueTapesMap[tapeId] = { collection: cName, name: tName, color: t.color || '#e67e22', trackCount: 0 };
          }
          
          if (t.type !== 'stub') {
              uniqueCollectionsMap[cName].trackCount++;
              uniqueTapesMap[tapeId].trackCount++;
          }
      }
   });

  let collectionsList = Object.values(uniqueCollectionsMap);
  let tapesList = Object.values(uniqueTapesMap);

  if (sortBy === 'az') {
     collectionsList.sort((a,b) => a.name.localeCompare(b.name));
     tapesList.sort((a,b) => a.name.localeCompare(b.name));
  } else if (sortBy === 'count') {
     collectionsList.sort((a,b) => b.tapes.size - a.tapes.size);
     tapesList.sort((a,b) => b.trackCount - a.trackCount);
  } else {
     collectionsList.reverse();
     tapesList.reverse();
  }

  return (
    <div className="min-h-screen p-4 md:p-8 flex flex-col items-center gap-8 relative overflow-hidden bg-[#0a0a0a]">
      {/* SIDE SPEAKER - LEFT */}
      <div className="fixed left-4 bottom-8 hidden xl:flex flex-col gap-2 w-56 h-[600px] z-0 px-2 group">
         <div className={`flex-1 speaker-cabinet rounded-lg p-2 flex flex-col items-stretch shadow-2xl relative overflow-hidden`}>
            {/* Grill Cloth Area */}
            <div className={`flex-1 grill-cloth-speaker rounded m-2 p-6 flex flex-col items-center justify-around transition-all ${isPlaying ? 'animate-thump' : ''}`}>
               {/* Tweeter */}
               <div className="w-16 h-16 rounded-full bg-black border-4 border-gray-800 shadow-inner flex items-center justify-center relative">
                  <div className="absolute inset-0 bg-gradient-to-tr from-transparent to-white/5 rounded-full"></div>
                  <div className="w-6 h-6 rounded-full bg-gray-900 border-2 border-gray-800"></div>
               </div>
               {/* Woofer */}
               <div className="w-40 h-40 rounded-full bg-black border-[12px] border-[#151515] shadow-2xl flex items-center justify-center relative">
                  <div className="absolute inset-0 bg-gradient-to-b from-white/10 to-transparent rounded-full opacity-20"></div>
                  <div className={`w-28 h-28 rounded-full bg-[#111] border-4 border-gray-800 transition-transform duration-75 ${isPlaying ? 'scale-110 shadow-[0_0_40px_rgba(255,255,255,0.05)]' : ''} flex items-center justify-center`}>
                     <div className="w-10 h-10 rounded-full bg-black border-2 border-gray-900"></div>
                  </div>
               </div>
            </div>
            {/* Marshall Gold Logo Area */}
            <div className="h-10 flex items-center justify-center border-t border-marshall-gold/10">
               <div className="text-marshall-gold/30 font-black italic text-xs tracking-tighter" style={{ fontFamily: 'Pacifico' }}>Vintage Master</div>
            </div>
         </div>
         <div className="h-14 w-full bg-[#151515] border-x-4 border-b-4 border-[#1a1a1a] rounded-b shadow-xl"></div>
      </div>

      {/* SIDE SPEAKER - RIGHT */}
      <div className="fixed right-4 bottom-8 hidden xl:flex flex-col gap-2 w-56 h-[600px] z-0 px-2 group">
         <div className={`flex-1 speaker-cabinet rounded-lg p-2 flex flex-col items-stretch shadow-2xl relative overflow-hidden`}>
            {/* Grill Cloth Area */}
            <div className={`flex-1 grill-cloth-speaker rounded m-2 p-6 flex flex-col items-center justify-around transition-all ${isPlaying ? 'animate-thump' : ''}`}>
               {/* Tweeter */}
               <div className="w-16 h-16 rounded-full bg-black border-4 border-gray-800 shadow-inner flex items-center justify-center relative">
                  <div className="absolute inset-0 bg-gradient-to-tr from-transparent to-white/5 rounded-full"></div>
                  <div className="w-6 h-6 rounded-full bg-gray-900 border-2 border-gray-800"></div>
               </div>
               {/* Woofer */}
               <div className="w-40 h-40 rounded-full bg-black border-[12px] border-[#151515] shadow-2xl flex items-center justify-center relative">
                  <div className="absolute inset-0 bg-gradient-to-b from-white/10 to-transparent rounded-full opacity-20"></div>
                  <div className={`w-28 h-28 rounded-full bg-[#111] border-4 border-gray-800 transition-transform duration-75 ${isPlaying ? 'scale-110 shadow-[0_0_40px_rgba(255,255,255,0.05)]' : ''} flex items-center justify-center`}>
                     <div className="w-10 h-10 rounded-full bg-black border-2 border-gray-900"></div>
                  </div>
               </div>
            </div>
            {/* Marshall Gold Logo Area */}
            <div className="h-10 flex items-center justify-center border-t border-marshall-gold/10">
               <div className="text-marshall-gold/30 font-black italic text-xs tracking-tighter" style={{ fontFamily: 'Pacifico' }}>Vintage Master</div>
            </div>
         </div>
         <div className="h-14 w-full bg-[#151515] border-x-4 border-b-4 border-[#1a1a1a] rounded-b shadow-xl"></div>
      </div>

      <header className="text-center mb-10 z-10">
        <h1 className="vault-logo text-[4rem] mb-2">The Eternal Vault</h1>
      </header>

      <main className="amp-head mx-auto">
        <div className="faceplate">
          {/* Left Side */}
          <div className="flex flex-col gap-6">
            <div className="flex justify-between items-center px-4">
              <div></div>
              <div className="flex gap-1 items-center">
                <div 
                  className="w-2 h-2 rounded-full" 
                  style={{
                    backgroundColor: isPlaying ? '#ff0000' : '#440000',
                    boxShadow: isPlaying ? '0 0 10px #ff0000' : 'none'
                  }}
                ></div>
                <span className="text-[8px] font-bold text-black/50 uppercase">POWER</span>
              </div>
            </div>

            <div 
              className="deck-display" 
              style={{ boxShadow: activeTrack ? `inset 0 0 50px ${activeTrack.color}33` : 'inset 0 0 30px rgba(0,0,0,1)' }}
            >
              {activeTrack ? (
                 <div className="cassette !h-[140px] !w-[260px] !pointer-events-none scale-100 flex-col shadow-[0_0_30px_rgba(0,0,0,0.8)] relative border-4 border-gray-300 transform-gpu bg-white">
                    <div className="tape-stripe" style={{ background: activeTrack.color, height: '20px' }}></div>
                    
                    <div className="flex flex-col text-center mt-2 px-4">
                      <div className="tape-title !text-lg text-black font-black uppercase overflow-hidden whitespace-nowrap">{activeTrack.tape?.toUpperCase()}</div>
                      <div className="tape-artist !text-[10px] text-gray-500 font-bold uppercase">{activeTrack.collection?.toUpperCase()}</div>
                    </div>
                    
                    {/* The Transparent Tape Window */}
                    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-[160px] h-[55px] bg-[#222] rounded-xl border-4 border-[#ddd] flex justify-between items-center px-3 shadow-inner">
                       <div className={`w-10 h-10 rounded-full bg-[#1a1a1a] border border-[#333] relative flex items-center justify-center ${isPlaying ? 'animate-[spin_4s_linear_infinite]' : ''}`}>
                             <div className="w-2 h-2 bg-white/80 rounded-full absolute shadow-[0_0_5px_white]"></div>
                             <div className="w-[110%] h-[2px] bg-white/40 absolute rotate-0"></div>
                             <div className="w-[110%] h-[2px] bg-white/40 absolute rotate-45"></div>
                             <div className="w-[110%] h-[2px] bg-white/40 absolute rotate-90"></div>
                             <div className="w-[110%] h-[2px] bg-white/40 absolute rotate-135"></div>
                       </div>
                       
                       {/* Tape bridge / magnetic band graphic */}
                       <div className="absolute left-1/2 bottom-0 -translate-x-1/2 flex items-end justify-center w-full h-full opacity-30">
                          <div className="w-16 h-8 bg-white/20 skew-x-[-20deg] border-x-2 border-white/20"></div>
                          <div className="w-full h-1 bg-[#444] absolute bottom-0"></div>
                       </div>

                       <div className={`w-10 h-10 rounded-full bg-[#1a1a1a] border border-[#333] relative flex items-center justify-center ${isPlaying ? 'animate-[spin_4s_linear_infinite]' : ''}`}>
                             <div className="w-2 h-2 bg-white/80 rounded-full absolute shadow-[0_0_5px_white]"></div>
                             <div className="w-[110%] h-[2px] bg-white/40 absolute rotate-0"></div>
                             <div className="w-[110%] h-[2px] bg-white/40 absolute rotate-45"></div>
                             <div className="w-[110%] h-[2px] bg-white/40 absolute rotate-90"></div>
                             <div className="w-[110%] h-[2px] bg-white/40 absolute rotate-135"></div>
                       </div>
                    </div>
                 </div>
              ) : (
                <>
                  <div className="flex gap-16 opacity-40">
                    <div className="spool"></div>
                    <div className="spool"></div>
                  </div>
                  <div className="absolute bottom-2 text-[8px] font-black text-white/20">MAGNETIC TAPE DRIVE</div>
                </>
              )}
            </div>

            <div className="bg-black/10 p-2 rounded border border-black/10 flex items-center justify-between gap-4">
              <div className="flex gap-2 flex-nowrap overflow-x-auto pb-1 scroll-custom">
                <Knob label="Vol" min={0} max={1} value={volume} onChange={setVolume} />
                <Knob label="Bass" min={-10} max={10} value={bass} onChange={setBass} />
                <Knob label="Mid" min={-10} max={10} value={mid} onChange={setMid} />
                <Knob label="Treb" min={-10} max={10} value={treble} onChange={setTreble} />
                <Knob label="Hiss" min={0} max={0.2} value={hissVal} onChange={setHissVal} />
                <Knob label="Gain" min={0.5} max={1.5} value={gain} onChange={setGain} />
              </div>

              <div className="flex flex-col items-center gap-4 shrink-0 border-l border-black/10 pl-6">
                <div className="text-right min-w-[80px]">
                  <button 
                    onClick={cycleMode}
                    className="bg-black/40 border border-marshall-gold/30 text-[8px] font-black text-marshall-gold px-2 py-1 rounded hover:bg-marshall-gold hover:text-black transition-colors mb-2 block w-full whitespace-nowrap shadow-[0_0_5px_rgba(197,160,89,0.3)]"
                  >
                    {eqMode.toUpperCase()}
                  </button>
                </div>

                {/* VINTAGE TOGGLE SWITCH - STACKED BELOW */}
                <div className="flex flex-col items-center gap-1">
                   <div className="text-[7px] text-black font-black uppercase mb-1 tracking-tighter">LO-FI ARCHIVE</div>
                   <button 
                      onClick={() => setIsVintage(!isVintage)}
                      className={`w-5 h-8 rounded-sm border-2 border-black/40 relative transition-all shadow-inner overflow-hidden flex flex-col items-center ${isVintage ? 'bg-black/20' : 'bg-black/10'}`}
                   >
                      <div className={`w-full h-1/2 transition-all ${isVintage ? 'bg-black/30 border-b border-black shadow-inner' : 'bg-transparent'}`}></div>
                      <div className={`w-3 h-4 bg-marshall-gold/60 border border-black/40 rounded-sm absolute transition-all ${isVintage ? 'top-[16px]' : 'top-[2px]'} shadow-sm`}></div>
                   </button>
                   <div className={`w-1.5 h-1.5 rounded-full mt-1 border border-black/20 transition-all ${isVintage ? 'bg-amber-500 shadow-[0_0_12px_rgba(245,158,11,1),0_0_4px_rgba(245,158,11,0.5)]' : 'bg-amber-950'}`}></div>
                </div>
              </div>
            </div>
          </div>

          {/* Right Side */}
          <div className="flex flex-col gap-5">
            <div className="lcd-display">{timeString}</div>
            
            <div className="bg-black p-4 border-2 border-white/10 rounded h-24 flex flex-col justify-center relative group/lcd overflow-hidden">
              <div className="text-red-500 text-xs font-bold truncate tracking-widest flex justify-between items-center z-10">
                <span>{activeTrack ? activeTrack.title.toUpperCase() : '-- NO INPUT --'}</span>
              </div>
              <div className="text-gray-500 text-[9px] font-bold mt-1 uppercase truncate z-10">
                {activeTrack ? `${activeTrack.artist} // ${activeTrack.tape} // ${activeTrack.collection}` : 'Standby Mode'}
              </div>
              
              {/* Mechanical Eject Button */}
              {activeTrack && (
                 <button 
                    onClick={ejectTape}
                    className="absolute bottom-1 right-1 opacity-10 group-hover/lcd:opacity-100 transition-all bg-white/5 border border-white/10 text-white w-6 h-6 flex items-center justify-center rounded hover:bg-red-500/20 hover:border-red-500/40 hover:text-red-500"
                    title="EJECT TAPE"
                 >
                    <i className="fas fa-eject text-[10px]"></i>
                 </button>
              )}
            </div>

            <div className="grid grid-cols-4 gap-2 mt-auto">
              <button 
                 onClick={toggleRecord} 
                 className={`btn-amp ${isRecording ? 'active !text-red-500 border-red-500 shadow-[0_0_15px_#ff0000] animate-pulse' : 'text-red-900'}`}
                 title="Record"
              ><i className="fas fa-circle"></i></button>
              <button onClick={rewind} className="btn-amp" title="Rewind"><i className="fas fa-backward"></i></button>
              <button onClick={fastForward} className="btn-amp" title="Fast Forward"><i className="fas fa-forward"></i></button>
              <button 
                onClick={togglePlay} 
                className={`btn-amp ${isPlaying ? 'active shadow-[0_0_10px_white]' : ''}`}
                title="Play"
              ><i className="fas fa-play"></i></button>
              
              <button onClick={pauseTrack} className={`btn-amp ${!isPlaying && activeIdx !== -1 ? 'active shadow-[0_0_10px_white]' : ''}`} title="Pause"><i className="fas fa-pause"></i></button>
              <button onClick={stopTrack} className="btn-amp" title="Stop"><i className="fas fa-stop"></i></button>
              <button onClick={prevTrack} className="btn-amp" title="Previous"><i className="fas fa-step-backward"></i></button>
              <button onClick={nextTrack} className="btn-amp" title="Next"><i className="fas fa-step-forward"></i></button>
            </div>
          </div>
        </div>

        {animatingTape && (
            <div 
                className="animating-tape cassette !w-[200px] !h-[90px] pointer-events-none"
                style={{
                    left: animatingTape.x,
                    top: animatingTape.y,
                    width: animatingTape.width,
                    height: animatingTape.height,
                    '--tx': `${animatingTape.tx}px`,
                    '--ty': `${animatingTape.ty}px`
                }}
            >
                <div className="tape-stripe" style={{ background: animatingTape.color }}></div>
                <div className="tape-label">
                    <div className="tape-title text-xs">{animatingTape.title}</div>
                </div>
            </div>
        )}

        <div className="absolute -bottom-6 w-full flex justify-center gap-4">
          <button 
            onClick={() => { setModalMode('collection'); }} 
            className="bg-white text-black px-6 py-2 rounded-full font-black text-xs border-4 border-black hover:bg-marshall-gold transition-colors shadow-xl"
          >
            ADD COLLECTION
          </button>
          <button 
            onClick={() => { setModalMode('tape'); }} 
            className="bg-white text-black px-6 py-2 rounded-full font-black text-xs border-4 border-black hover:bg-marshall-gold transition-colors shadow-xl"
          >
            ADD TAPE
          </button>
          <button 
            onClick={() => { setRecordedFile(null); setModalMode('song'); }} 
            className="bg-white text-black px-6 py-2 rounded-full font-black text-xs border-4 border-black hover:bg-marshall-gold transition-colors shadow-xl"
          >
            ADD SONG
          </button>
        </div>
      </main>

      <section className="amp-cabinet mx-auto">
        <div className="flex justify-between items-center mb-6 flex-wrap gap-4">
          <div className="flex items-end gap-3">
             <span className="text-white font-black italic text-2xl" style={{ fontFamily: 'Pacifico' }}>The Cabinet</span>
          </div>
          <div className="flex gap-4 items-center flex-grow justify-end">
             <div className="relative group flex-grow max-w-xs">
                <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-600 group-focus-within:text-marshall-gold"></i>
                <input 
                    type="text" 
                    placeholder="SEARCH THE VAULT..." 
                    value={searchTerm} 
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-48 md:w-64 bg-black/40 border border-white/5 rounded-full py-1.5 pl-10 pr-4 text-xs text-white placeholder:text-gray-700 focus:outline-none focus:border-marshall-gold/40 focus:bg-black/60 transition-all font-black uppercase tracking-widest"
                />
             </div>
             <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="bg-black/50 text-[10px] text-marshall-gold font-black border border-marshall-gold/30 rounded p-2 outline-none uppercase tracking-widest">
                <option value="newest">NEWEST FIRST</option>
                <option value="az">A-Z ORDER</option>
                <option value="count">MOST CONTENT</option>
             </select>
          </div>
        </div>
        
        <div className="grill-cloth">
          {/* FOLDERS VIEW */}
          {!selectedCollection && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6 overflow-y-auto max-h-[500px] scroll-custom pr-2">
                 {collectionsList.map((col, i) => (
                    <div 
                       key={col.name + i} 
                       onClick={() => setSelectedCollection(col.name)}
                       className="bg-[#111] border border-gray-800 rounded p-4 cursor-pointer hover:bg-[#222] transition-colors border-t-8 border-t-marshall-gold shadow-md group relative h-36 flex flex-col justify-between"
                    >
                       <div className="flex justify-between items-start">
                          <i className="fas fa-folder-open text-marshall-gold text-3xl group-hover:scale-110 transition-transform"></i>
                          <div className="text-[10px] text-gray-500 font-mono font-black tracking-widest">{col.tapes.size} TAPES</div>
                       </div>
                       <div className="flex justify-between items-end">
                         <div className="overflow-hidden">
                           <div className="text-white font-bold text-sm truncate">{col.name.toUpperCase()}</div>
                           <div className="text-[9px] text-gray-400 mt-1 uppercase">{col.trackCount} TOTAL TRACKS</div>
                         </div>
                         <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all translate-y-2 group-hover:translate-y-0">
                            <button 
                               onClick={(e) => {
                                  e.stopPropagation();
                                  setEditTarget({ name: col.name, idx: i });
                                  setModalMode('collection');
                               }}
                               className="w-6 h-6 flex items-center justify-center rounded-full bg-white/5 border border-white/10 text-gray-500 hover:text-marshall-gold hover:border-marshall-gold transition-colors"
                            >
                               <i className="fas fa-edit text-[9px]"></i>
                            </button>
                            <button 
                               onClick={(e) => {
                                  e.stopPropagation();
                                  const newLib = library.filter(t => t.collection !== col.name);
                                  setLibrary(newLib);
                                  localforage.setItem('vault_library', newLib).catch(console.error);
                               }}
                               className="w-6 h-6 flex items-center justify-center rounded-full bg-white/5 border border-white/10 text-gray-500 hover:text-red-500 hover:border-red-500/30 transition-colors"
                            >
                               <i className="fas fa-trash text-[9px]"></i>
                            </button>
                         </div>
                       </div>
                    </div>
                 ))}
                 {collectionsList.length === 0 && (
                    <div className="col-span-full py-20 text-center opacity-10 italic">
                       <i className="fas fa-box-open text-7xl mb-4 text-marshall-gold/20"></i>
                       <p className="text-2xl font-bold">Archives are Empty</p>
                    </div>
                 )}
            </div>
          )}

          {/* TAPES VIEW */}
          {selectedCollection && !selectedTape && (
            <div className="flex flex-col gap-4">
              <div className="flex justify-between items-center mb-2">
                  <button onClick={() => setSelectedCollection(null)} className="text-white font-bold text-xs hover:text-marshall-gold flex items-center gap-2 bg-black/30 px-3 py-2 rounded transition-colors pl-0 bg-transparent">
                    <i className="fas fa-arrow-left"></i> BACK TO ARCHIVES
                  </button>
                  <span className="text-marshall-gold font-bold uppercase tracking-widest text-xs"><i className="fas fa-folder-open"></i> {selectedCollection}</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 overflow-y-auto max-h-[450px] scroll-custom pr-2">
                {tapesList.filter(tp => tp.collection === selectedCollection).map((tp, i) => {
                  const isPlayingThis = activeTrack && activeTrack.collection === tp.collection && activeTrack.tape === tp.name;
                  return (
                    <div 
                      key={tp.name + i} 
                      className={`cassette group relative w-full aspect-[1.6/1] cursor-pointer transition-all hover:scale-105 ${isPlayingThis ? 'playing' : ''}`}
                      onClick={() => setSelectedTape(tp.name)}
                    >
                      {/* Physical Shell */}
                      <div className="absolute inset-0 bg-[#1a1a1a] rounded-lg border border-white/5 shadow-2xl overflow-hidden flex flex-col">
                        {/* Screws */}
                        <div className="absolute top-1.5 left-1.5 w-1 h-1 bg-gray-800 rounded-full border border-white/5 shadow-inner"></div>
                        <div className="absolute top-1.5 right-1.5 w-1 h-1 bg-gray-800 rounded-full border border-white/5 shadow-inner"></div>
                        <div className="absolute bottom-6 left-1.5 w-1 h-1 bg-gray-800 rounded-full border border-white/5 shadow-inner"></div>
                        <div className="absolute bottom-6 right-1.5 w-1 h-1 bg-gray-800 rounded-full border border-white/5 shadow-inner"></div>

                        {/* Top Label/Stripe - Integrated Branding */}
                        <div className="h-6 w-full flex items-center justify-between px-3 relative shadow-[inset_0_1px_1px_rgba(255,255,255,0.2)]" style={{ background: tp.color }}>
                           <div className="text-[10px] text-white font-black uppercase tracking-tighter truncate drop-shadow-md">{tp.name}</div>
                           <div className="text-[7px] text-white/60 font-black uppercase tracking-widest">{tp.trackCount} TRK</div>
                        </div>

                        {/* Center Reel Area - Clear View */}
                        <div className="flex-1 flex flex-col items-center justify-center p-2 relative bg-gradient-to-b from-black/20 to-transparent">
                           {/* Reels */}
                           <div className="flex gap-10 justify-center items-center z-10">
                              <div className={`w-8 h-8 rounded-full bg-[#111] border-2 border-white/10 shadow-inner flex items-center justify-center relative ${isPlayingThis && isPlaying ? 'animate-spin-slow' : ''}`}>
                                 <div className="w-[1px] h-3 bg-gray-600 absolute top-0"></div>
                                 <div className="w-[1px] h-3 bg-gray-600 absolute bottom-0"></div>
                                 <div className="w-3 h-[1px] bg-gray-600 absolute left-0"></div>
                                 <div className="w-3 h-[1px] bg-gray-700 absolute right-0"></div>
                                 <div className="w-2.5 h-2.5 bg-black rounded-full border border-white/5"></div>
                              </div>
                              <div className={`w-8 h-8 rounded-full bg-[#111] border-2 border-white/10 shadow-inner flex items-center justify-center relative ${isPlayingThis && isPlaying ? 'animate-spin-slow' : ''}`}>
                                 <div className="w-[1px] h-3 bg-gray-700 absolute top-0"></div>
                                 <div className="w-[1px] h-3 bg-gray-700 absolute bottom-0"></div>
                                 <div className="w-3 h-[1px] bg-gray-700 absolute left-0"></div>
                                 <div className="w-3 h-[1px] bg-gray-700 absolute right-0"></div>
                                 <div className="w-2.5 h-2.5 bg-black rounded-full border border-white/5"></div>
                              </div>
                           </div>
                        </div>

                        {/* Bottom Shell Dent */}
                        <div className="h-5 w-full bg-[#151515] border-t border-black/50 flex justify-center items-center gap-4">
                           <div className="w-10 h-1.5 bg-black/40 rounded-full border border-white/5 shadow-inner"></div>
                           <div className="w-1.5 h-1.5 bg-black rounded-full border border-white/5"></div>
                           <div className="w-1.5 h-1.5 bg-black rounded-full border border-white/5"></div>
                           <div className="w-10 h-1.5 bg-black/40 rounded-full border border-white/5 shadow-inner"></div>
                        </div>
                      </div>

                      {/* Side Edit Controls (Overlay on Hover) */}
                      <div className="absolute top-2 right-2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-all scale-75 origin-top-right group-hover:scale-100 z-20">
                        <button 
                            onClick={(e) => { e.stopPropagation(); setEditTarget({ ...tp, idx: i }); setModalMode('tape'); }}
                            className="bg-marshall-gold border border-black/20 w-6 h-6 rounded flex items-center justify-center text-black hover:bg-white transition-colors shadow-lg"
                        >
                            <i className="fas fa-pencil-alt text-[10px]"></i>
                        </button>
                        <button 
                            onClick={(e) => { e.stopPropagation(); const newLib = library.filter(t => !(t.collection === tp.collection && t.tape === tp.name)); setLibrary(newLib); localforage.setItem('vault_library', newLib).catch(console.error); }}
                            className="bg-red-500 border border-black/20 w-6 h-6 rounded flex items-center justify-center text-white hover:bg-black transition-colors shadow-lg"
                        >
                            <i className="fas fa-times text-[10px]"></i>
                        </button>
                      </div>
                      
                      {/* Active Indicator Glow */}
                      {isPlayingThis && (
                        <div className="absolute inset-0 border-2 border-marshall-gold/40 rounded-lg animate-pulse pointer-events-none shadow-[0_0_20px_rgba(197,160,89,0.3)]"></div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TRACK-LIST VIEW */}
          {selectedCollection && selectedTape && (
            <div className="flex flex-col h-full overflow-hidden">
               <div className="flex items-center gap-4 mb-4 border-b border-white/5 pb-4">
                  <button 
                    onClick={() => setSelectedTape(null)}
                    className="bg-white/5 border border-white/10 text-white text-[10px] px-3 py-1 rounded-full hover:bg-white/10 transition-all font-black"
                  >
                    <i className="fas fa-arrow-left"></i> BACK TO TAPES
                  </button>
                  <div className="flex flex-col">
                    <h2 className="text-marshall-gold font-black uppercase text-sm tracking-tighter leading-none italic">{selectedTape}</h2>
                    <span className="text-[8px] text-gray-500 font-bold uppercase tracking-widest mt-1">Cabinet // {selectedCollection} // Track-List</span>
                  </div>
               </div>
              
               <div className="grid grid-cols-1 md:grid-cols-2 gap-3 overflow-y-auto pr-2 scroll-custom flex-1">
                 {library
                    .map((track, originalIndex) => ({ track, originalIndex }))
                    .filter(({track}) => track.collection === selectedCollection && track.tape === selectedTape && track.type !== 'stub')
                    .map(({track, originalIndex}, i) => (
                    <div 
                       key={track.title + i}
                       onClick={(e) => startTrack(originalIndex, e)}
                       className={`flex items-center justify-between p-3 rounded border transition-all cursor-pointer group ${activeIdx === originalIndex ? 'bg-marshall-gold/20 border-marshall-gold shadow-[0_0_15px_rgba(197,160,89,0.15)]' : 'bg-black/40 border-white/5 hover:bg-white/5 hover:border-white/20'}`}
                    >
                       <div className="flex items-center gap-4 min-w-0">
                          <div className={`w-8 h-8 rounded flex items-center justify-center text-[11px] font-black ${activeIdx === originalIndex ? 'bg-marshall-gold text-black' : 'bg-white/5 text-gray-600'}`}>
                             {activeIdx === originalIndex && isPlaying ? <i className="fas fa-volume-up animate-pulse"></i> : (i + 1)}
                          </div>
                          <div className="flex flex-col min-w-0">
                             <div className={`text-xs font-bold truncate ${activeIdx === originalIndex ? 'text-marshall-gold' : 'text-gray-200'}`}>
                                {track.title.toUpperCase()}
                             </div>
                             <div className="text-[9px] text-gray-500 font-bold truncate uppercase">{track.artist}</div>
                          </div>
                       </div>
                       <div className="flex items-center gap-4 shrink-0">
                          <div className="flex gap-1 scale-90 translate-x-2 group-hover:translate-x-0 opacity-0 group-hover:opacity-100 transition-all duration-300">
                             <button 
                                onClick={async (e) => {
                                   e.stopPropagation();
                                   try {
                                       // Global Purge from Cloud
                                       await deleteDoc(doc(db, 'vault_library', track.id));
                                       if (track.type === 'file' && track.storagePath) {
                                           const fileRef = ref(storage, track.storagePath);
                                           await deleteObject(fileRef);
                                       }
                                       if (activeIdx === originalIndex) stopTrack();
                                   } catch (err) {
                                       console.error("Cloud Purge Error: ", err);
                                   }
                                }}
                                className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-red-500/10 text-gray-600 hover:text-red-500 transition-colors"
                                title="Delete Track"
                             >
                                <i className="fas fa-trash text-[10px]"></i>
                             </button>
                          </div>
                          <div className="w-10 text-right text-[10px] text-gray-600 font-mono">{(originalIndex % 4 + 3)}:{(originalIndex % 60).toString().padStart(2, '0')}</div>
                       </div>
                    </div>
                 ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {modalMode && (
        <AddModal 
          mode={modalMode}
          editTarget={editTarget}
          collectionsList={collectionsList}
          tapesList={tapesList}
          defaultFile={recordedFile}
          preselectedCollection={selectedCollection}
          preselectedTape={selectedTape}
          onClose={() => { setModalMode(null); setEditTarget(null); setRecordedFile(null); }} 
          onAdd={async (item) => {
            try {
              let finalItem = { ...item, createdAt: new Date() };
              // If it's a song with a physical file, upload to storage first
              if (item.type === 'file' && item.fileObj) {
                  const storagePath = `audio/${Date.now()}_${item.fileObj.name}`;
                  const fileRef = ref(storage, storagePath);
                  try {
                    await uploadBytes(fileRef, item.fileObj);
                    const downloadURL = await getDownloadURL(fileRef);
                    finalItem.src = downloadURL;
                    finalItem.storagePath = storagePath;
                    delete finalItem.fileObj; // Clean up before DB save
                  } catch (storageErr) {
                    console.error("FIREBASE STORAGE REJECTED SIGNAL:", storageErr);
                    alert("CLOUD STORAGE ERROR: Your audio master was rejected. Check your Storage Rules!");
                    return;
                  }
              }
              try {
                await addDoc(collection(db, 'vault_library'), finalItem);
                setModalMode(null);
                setRecordedFile(null);
              } catch (dbErr) {
                console.error("FIRESTORE REJECTED SIGNAL:", dbErr);
                alert("DATABASE ERROR: Your metadata was rejected. Check your Firestore Rules!");
              }
            } catch (err) {
              console.error("GENERAL CLOUD SIGNAL ERROR:", err);
              alert("CRITICAL SYNC ERROR: Check your internet connection and Firebase config!");
            }
          }} 
          onUpdate={async (updated, oldName) => {
            try {
              if (modalMode === 'collection') {
                  const toUpdate = library.filter(t => t.collection === oldName);
                  for (const t of toUpdate) {
                      await updateDoc(doc(db, 'vault_library', t.id), { collection: updated.collection });
                  }
              } else if (modalMode === 'tape') {
                  const toUpdate = library.filter(t => t.collection === updated.collection && t.tape === oldName);
                  for (const t of toUpdate) {
                      await updateDoc(doc(db, 'vault_library', t.id), { tape: updated.tape, color: updated.color });
                  }
              } else if (editTarget && editTarget.id) {
                  await updateDoc(doc(db, 'vault_library', editTarget.id), updated);
              }
              setModalMode(null);
              setEditTarget(null);
            } catch (err) {
              console.error("Cloud Update Error: ", err);
            }
          }}
        />
      )}

      <div className="fixed inset-0 w-full h-full opacity-0 pointer-events-none z-[-1]">
        {(!activeTrack || activeTrack.type !== 'file') ? (
            <ReactPlayer 
              ref={playerRef} 
              url={playSrc ? playSrc : ''} 
              playing={isPlaying}
              volume={volume}
              muted={false}
              playbackRate={gain}
              onEnded={nextTrack}
              onError={(err) => {
                 console.error("Audio Engine Error: ", err);
              }}
              width="100%"
              height="100%"
              config={{
                youtube: {
                  playerVars: { autoplay: 1, origin: window.location.origin }
                }
              }}
            />
        ) : (
            <audio 
              ref={nativeAudioRef} 
              src={playSrc} 
              crossOrigin="anonymous"
              onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime)}
              onEnded={nextTrack}
            />
        )}
      </div>
      {/* CASSETTE INSERT ANIMATION OVERLAY */}
      {animatingTape && (
        <div 
          className="fixed pointer-events-none z-[9999]"
          style={{
            left: animatingTape.x,
            top: animatingTape.y,
            width: animatingTape.width,
            height: animatingTape.height
          }}
        >
          <div 
            className={`${animatingTape.isEjecting ? 'animate-eject' : 'animate-insert'} bg-black border-2 border-marshall-gold/20 rounded shadow-2xl relative`}
            style={{ width: '100%', height: '100%' }}
          >
             <div className="absolute top-0 left-0 w-full h-1" style={{ background: animatingTape.color }}></div>
             <div className="p-2 flex flex-col justify-center h-full">
                <div className="text-[6px] font-black text-marshall-gold/40 mb-1">{animatingTape.collection}</div>
                <div className="text-[10px] text-white font-bold leading-none truncate">{animatingTape.title}</div>
             </div>
          </div>
        </div>
      )}
      </div>
  )
}

function Knob({ value, onChange, min = 0, max = 1, label }) {
  const [isDragging, setIsDragging] = useState(false);
  const startY = useRef(0);
  const startVal = useRef(value);

  const handleMouseDown = (e) => {
    setIsDragging(true);
    startY.current = e.clientY;
    startVal.current = value;
  };

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e) => {
      const deltaY = startY.current - e.clientY;
      const range = max - min;
      let newVal = startVal.current + (deltaY / 100) * range;
      newVal = Math.max(min, Math.min(max, newVal));
      onChange(newVal);
    };
    const handleMouseUp = () => setIsDragging(false);
    
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, max, min, onChange]);

  const pct = (value - min) / (max - min);
  const deg = -135 + (pct * 270);

  return (
    <div className="knob-container">
      <div 
        className="knob cursor-ns-resize" 
        onMouseDown={handleMouseDown}
        style={{ 
          transform: `rotate(${deg}deg)`,
          transition: isDragging ? 'none' : 'transform 0.1s' 
        }}
      ></div>
      <span className="knob-label">{label}</span>
    </div>
  );
}



function AddModal({ onClose, onAdd, onUpdate, editTarget, defaultFile, mode, collectionsList, tapesList, preselectedCollection, preselectedTape }) {
  const isCollection = mode === 'collection';
  const isTape = mode === 'tape';
  const isSong = mode === 'song';
  const isEdit = !!editTarget;
  
  const [srcType, setSrcType] = useState(editTarget ? editTarget.type : 'file');
  
  const [formData, setFormData] = useState({ 
    title: editTarget ? (isCollection ? editTarget.name : (isTape ? editTarget.name : editTarget.title)) : '', 
    collection: editTarget ? editTarget.collection : (preselectedCollection || (collectionsList[0] ? collectionsList[0].name : '')),
    tape: editTarget ? editTarget.tape : (preselectedTape || ''),
    artist: editTarget ? editTarget.artist : '', 
    url: editTarget ? editTarget.src : '', 
    color: editTarget ? editTarget.color : '#e67e22' 
  });
  
  const [file, setFile] = useState(defaultFile || null);

  useEffect(() => {
    if (defaultFile && !isCollection && !isTape) {
       // Only set artist to 'Self' but let user pick collection/tape
       setFormData(f => ({ 
           ...f, 
           title: `RECORDING_${new Date().toLocaleTimeString()}`, 
           artist: 'Studio Session', 
           collection: preselectedCollection || f.collection || (collectionsList[0] ? collectionsList[0].name : 'Studio Archives'), 
           tape: preselectedTape || f.tape || 'Session Tape 1' 
       }));
    }
  }, [defaultFile, isCollection, isTape, preselectedCollection, preselectedTape, collectionsList]);

  // Sync tape dropdown intelligently based on chosen collection
  useEffect(() => {
      if (!isSong || collectionsList.length === 0) return;
      
      const availableTapes = tapesList.filter(t => t.collection === formData.collection);
      if (availableTapes.length > 0) {
          if (!availableTapes.find(t => t.name === formData.tape)) {
              setFormData(f => ({ ...f, tape: availableTapes[0].name }));
          }
      } else {
          setFormData(f => ({ ...f, tape: '' }));
      }
  }, [formData.collection, tapesList, isSong, collectionsList]);

  const handleSubmit = (e) => {
    e.preventDefault();
    
    if (isEdit) {
       onUpdate({
           title: formData.title,
           collection: formData.collection,
           tape: formData.tape,
           artist: formData.artist,
           color: formData.color
       }, isCollection ? editTarget.name : (isTape ? editTarget.name : null));
       return;
    }

    if (isCollection) {
      onAdd({
        type: 'stub',
        stubType: 'collection',
        collection: formData.title || 'New Collection',
        timestamp: Date.now()
      });
      return;
    }

    if (isTape) {
      onAdd({
        type: 'stub',
        stubType: 'tape',
        collection: formData.collection || 'General',
        tape: formData.title || 'New Tape',
        color: formData.color,
        timestamp: Date.now()
      });
      return;
    }

    let src = '';
    if (srcType === 'link') src = formData.url;

    if (srcType === 'link' && !src) return;
    
    // Validate File
    if (srcType === 'file' && !file && !defaultFile) return;

    if (srcType === 'file') {
        const itemBody = {
            title: formData.title || 'Unknown Track',
            collection: formData.collection || 'General',
            tape: formData.tape || 'Main Tape',
            artist: formData.artist || 'Unknown Artist',
            color: formData.color,
            type: 'file',
            timestamp: Date.now()
        };

        if (file) {
            onAdd({ ...itemBody, fileObj: file });
        } else if (defaultFile) {
            // Convert dataURL recording back to Blob
            fetch(defaultFile).then(res => res.blob()).then(blob => {
                onAdd({ ...itemBody, fileObj: blob });
            });
        }
        return;
    }

    onAdd({
      title: formData.title || 'Unknown Track',
      collection: formData.collection || 'General',
      tape: formData.tape || 'Main Tape',
      artist: formData.artist || 'Unknown Artist',
      color: formData.color,
      src: src,
      fileObj: null,
      type: srcType,
      timestamp: Date.now()
    });
  };

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    if (!selectedFile) return;
    setFile(selectedFile);

    const nameStr = selectedFile.name.replace(/\.[^/.]+$/, "");
    let fallbackTitle = nameStr;
    let fallbackArtist = '';
    
    if (nameStr.includes(' - ')) {
       const parts = nameStr.split(' - ');
       fallbackArtist = parts[0].trim();
       fallbackTitle = parts.slice(1).join(' - ').trim();
    } // else could try other splits, but ' - ' is standard

    // Extract ID3 Tags
    import('jsmediatags').then((jsmd) => {
        const jsmediatags = jsmd.default || jsmd;
        jsmediatags.read(selectedFile, {
            onSuccess: function(tag) {
                setFormData(f => ({ 
                    ...f, 
                    title: tag.tags.title || fallbackTitle, 
                    artist: tag.tags.artist || fallbackArtist || 'Unknown Artist'
                }));
            },
            onError: function(error) {
                console.warn('ID3 Engine Warning:', error);
                setFormData(f => ({ ...f, title: fallbackTitle, artist: fallbackArtist || 'Unknown Artist' }));
            }
        });
    }).catch(err => {
        setFormData(f => ({ ...f, title: fallbackTitle, artist: fallbackArtist || 'Unknown Artist' }));
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-md">
      <div className="amp-head !max-w-md p-2 w-full">
        <div className="faceplate !grid-cols-1 p-8">
          <h2 className="vault-logo text-center text-4xl mb-6">
            {isEdit ? 'EDITING ARTIFACT' : (isCollection ? 'NEW COLLECTION FOLDER' : isTape ? 'NEW CASSETTE TAPE' : defaultFile ? 'SAVE STUDIO RECORDING' : 'NEW MASTER RECORD')}
          </h2>
          {isSong && !isEdit && defaultFile && (
            <p className="text-black/60 text-[10px] font-black uppercase tracking-[0.2em] text-center mb-4">Choose an archive folder and tape for your recording</p>
          )}
          <form onSubmit={handleSubmit} className="space-y-4">
            
            {/* COLLECTION CREATOR/EDITOR */}
            {isCollection && (
              <input 
                type="text" required placeholder="COLLECTION FOLDER NAME" 
                value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})}
                className="w-full bg-black/20 border-2 border-black/30 p-3 text-black font-bold outline-none focus:bg-white/20" 
              />
            )}

            {/* TAPE CREATOR/EDITOR */}
            {isTape && (
              <>
                <input 
                  type="text" required placeholder="CASSETTE TAPE NAME" 
                  value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})}
                  className="w-full bg-black/20 border-2 border-black/30 p-3 text-black font-bold outline-none focus:bg-white/20" 
                />
                
                {(!isEdit && collectionsList.length > 0) ? (
                  <div className="flex bg-black/20 border-2 border-black/30 w-full focus-within:bg-white/20 transition-colors">
                     <div className="w-1/3 bg-black/10 flex items-center justify-center text-[10px] font-black border-r border-black/20 text-black px-2">FOLDER</div>
                     <select 
                       value={formData.collection} onChange={e => setFormData({...formData, collection: e.target.value})}
                       className="w-2/3 p-3 text-black font-bold outline-none bg-transparent"
                     >
                       {collectionsList.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                     </select>
                  </div>
                ) : (
                  <input 
                    type="text" required placeholder="COLLECTION NAME" 
                    value={formData.collection} onChange={e => setFormData({...formData, collection: e.target.value})}
                    readOnly={isEdit}
                    className="w-full bg-black/20 border-2 border-black/30 p-3 text-black font-bold outline-none focus:bg-white/20 disabled:opacity-50" 
                  />
                )}

                <div className="flex justify-between items-center bg-black/20 border-2 border-black/30 p-2 focus-within:bg-white/20">
                   <label className="text-black font-black text-xs px-2 w-1/3">TAPE STRIPE COLOR</label>
                   <input 
                     type="color" 
                     value={formData.color} onChange={e => setFormData({...formData, color: e.target.value})}
                     className="w-2/3 h-8 bg-transparent cursor-pointer outline-none border-none" 
                   />
                </div>
              </>
            )}

            {/* SONG CREATOR/EDITOR */}
            {isSong && (
              <>
                <input 
                  type="text" required placeholder="TRACK TITLE" 
                  value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})}
                  className="w-full bg-black/20 border-2 border-black/30 p-3 text-black font-bold outline-none focus:bg-white/20" 
                />
                <input 
                  type="text" required placeholder="ARTIST" 
                  value={formData.artist} onChange={e => setFormData({...formData, artist: e.target.value})}
                  className="w-full bg-black/20 border-2 border-black/30 p-3 text-black font-bold outline-none focus:bg-white/20" 
                />

                {(collectionsList.length > 0) ? (
                  <div className="flex bg-black/20 border-2 border-black/30 w-full focus-within:bg-white/20 transition-colors">
                     <select 
                       value={formData.collection} onChange={e => setFormData({...formData, collection: e.target.value})}
                       className="w-full p-3 text-black font-bold outline-none bg-transparent"
                     >
                       {collectionsList.map(c => <option key={c.name} value={c.name}>📂 {c.name}</option>)}
                     </select>
                  </div>
                ) : (
                  <input 
                    type="text" required placeholder="NEW COLLECTION" 
                    value={formData.collection} onChange={e => setFormData({...formData, collection: e.target.value})}
                    className="w-full bg-black/20 border-2 border-black/30 p-3 text-black font-bold outline-none focus:bg-white/20" 
                  />
                )}

                {tapesList.filter(t => t.collection === formData.collection).length > 0 ? (
                  <div className="flex bg-black/20 border-2 border-black/30 w-full focus-within:bg-white/20 transition-colors">
                     <select 
                       value={formData.tape} onChange={e => setFormData({...formData, tape: e.target.value})}
                       className="w-full p-3 text-black font-bold outline-none bg-transparent"
                     >
                       {tapesList.filter(t => t.collection === formData.collection).map(t => <option key={t.name} value={t.name}>📼 {t.name}</option>)}
                     </select>
                  </div>
                ) : (
                  <input 
                    type="text" required placeholder="NEW TAPE ASSIGNMENT" 
                    value={formData.tape} onChange={e => setFormData({...formData, tape: e.target.value})}
                    className="w-full bg-black/20 border-2 border-black/30 p-3 text-black font-bold outline-none focus:bg-white/20" 
                  />
                )}
                
                {!isEdit && (
                   <div className="w-full bg-black/20 border-2 border-black/30 flex items-center p-2 mt-4 text-left">
                      <input 
                        type="file" accept="audio/*" 
                        onChange={handleFileChange}
                        className="w-full pl-2 text-white font-bold text-sm file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-bold file:bg-white file:text-black hover:file:bg-marshall-gold hover:file:text-white transition-colors cursor-pointer" 
                        required={!defaultFile}
                      />
                   </div>
                )}
              </>
            )}
            
            <div className="flex gap-4 pt-4 mt-8">
              <button type="button" onClick={onClose} className="flex-1 text-black font-black text-xs border border-transparent hover:border-black transition-all">DISCARD</button>
              <button type="submit" className="flex-1 bg-black text-white font-black py-4 rounded text-xs hover:bg-[#c5a059] transition-colors hover:text-black">
                {isEdit ? 'UPDATE ARTIFACT' : 'SAVE MASTER'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default App;
