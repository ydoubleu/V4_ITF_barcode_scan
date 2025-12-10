import React, { useState, useEffect, useRef, useCallback } from 'react';
import { BrowserMultiFormatReader, BarcodeFormat, DecodeHintType } from '@zxing/library';
import { AlertCircle, Scan } from 'lucide-react';

interface ScannerProps {
  onScan: (result: string, format: string) => void;
  onError: (error: string) => void;
  isPaused: boolean;
  s21Mode?: boolean; // S21 Mode
  initialZoom?: number | null; // Session-based zoom
  onZoomChange?: (zoom: number) => void; // Zoom change handler
}

// React.memo: Prevents unnecessary re-renders (camera restarts) when parent state changes
export const Scanner = React.memo<ScannerProps>(({ onScan, onError, isPaused, s21Mode = false, initialZoom, onZoomChange }) => {
  const [hasCameraPermission, setHasCameraPermission] = useState<boolean | null>(null);
  
  // Zoom State
  const [zoom, setZoom] = useState<number>(1);
  const [zoomCap, setZoomCap] = useState<{ min: number, max: number, step: number } | null>(null);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoTrackRef = useRef<MediaStreamTrack | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const codeReaderRef = useRef<BrowserMultiFormatReader | null>(null);
  
  // Track active state and busy state to prevent freezing
  const activeRef = useRef<boolean>(!isPaused);
  const isBusyRef = useRef<boolean>(false);

  useEffect(() => {
    activeRef.current = !isPaused;
  }, [isPaused]);

  // 1. Initialize Decoder Engine (ZXing) - STRICTLY ITF ONLY
  useEffect(() => {
    const hints = new Map<DecodeHintType, any>();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.ITF // Changed: Only allow ITF format
    ]);
    hints.set(DecodeHintType.TRY_HARDER, true); // Enables rotation support (vertical barcodes)
    
    codeReaderRef.current = new BrowserMultiFormatReader(hints);

    return () => {
      // Cleanup
      codeReaderRef.current = null;
    };
  }, []);

  // 2. Start Camera Stream (Robust Fallback Logic & Watchdogs)
  useEffect(() => {
    let isMounted = true;

    const startCamera = async () => {
      try {
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(t => t.stop());
        }

        let stream: MediaStream | null = null;

        // Strategy: Use 'environment' camera with ideal resolution
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { 
              facingMode: 'environment', // Strictly prefer rear camera
              // Use standard HD resolution which is well supported and performant
              width: { ideal: 1280 }, 
              height: { ideal: 720 }
            }
          });
        } catch (err) {
            console.error("Camera access failed", err);
            throw err;
        }

        if (!isMounted) {
            stream?.getTracks().forEach(t => t.stop());
            return;
        }

        if (!stream) throw new Error("No stream found");

        streamRef.current = stream;
        
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          // Ensure play is called to prevent black screen on some devices
          videoRef.current.onloadedmetadata = () => {
             videoRef.current?.play().catch(e => console.error("Play error", e));
          };
        }

        setHasCameraPermission(true);

        const track = stream.getVideoTracks()[0];
        videoTrackRef.current = track;
        
        // Watchdog 1: Handle unexpected track ending
        track.onended = () => {
            console.warn("Video track ended unexpectedly, restarting...");
            if (isMounted) startCamera();
        };

        const capabilities = track.getCapabilities() as any;

        // Setup Zoom
        if (capabilities?.zoom) {
          setZoomCap({
            min: capabilities.zoom.min,
            max: capabilities.zoom.max,
            step: capabilities.zoom.step
          });

          // Determine Initial Zoom
          // Priority: 1. Session Zoom (Prop), 2. Default (2.0x for ALL modes)
          let targetZoom = 2.0; 

          if (initialZoom != null) {
              targetZoom = initialZoom;
          } else {
             // Unified 2.0x Zoom for both S21 Mode and Normal Mode
             targetZoom = 2.0;
          }
          
          // Clamp target zoom to device capabilities
          const clampedZoom = Math.min(Math.max(targetZoom, capabilities.zoom.min), capabilities.zoom.max);
          
          setZoom(clampedZoom);
          
          // Apply initial zoom
          try {
            track.applyConstraints({ advanced: [{ zoom: clampedZoom }] } as any);
          } catch (e) {
            console.warn("Failed to apply initial zoom", e);
          }
        }

        // Force Continuous Focus - Initial Attempt
        const constraints = { advanced: [{ focusMode: 'continuous' }, { exposureMode: 'continuous' }] };
        try {
            await track.applyConstraints(constraints as any);
        } catch(e) {
            // Ignore if unsupported
        }

      } catch (err) {
        if (isMounted) {
            console.error("Camera Init Error:", err);
            setHasCameraPermission(false);
            onError("카메라를 실행할 수 없습니다.");
        }
      }
    };

    startCamera();

    // Watchdog 2: Visibility Change (Restart camera if tab comes back to foreground)
    const handleVisibilityChange = () => {
        if (document.visibilityState === 'visible') {
            const track = streamRef.current?.getVideoTracks()[0];
            if (!track || track.readyState === 'ended' || track.muted) {
                console.log("Tab visible, restarting camera...");
                startCamera();
            }
        }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      isMounted = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => {
            track.onended = null;
            track.stop();
        });
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [onError, s21Mode]); // Re-run if s21Mode changes

  // Active Focus Maintenance Loop
  useEffect(() => {
      if (!hasCameraPermission) return;
      
      const focusInterval = setInterval(() => {
          if (videoTrackRef.current && videoTrackRef.current.readyState === 'live') {
              try {
                  // Re-apply continuous focus
                  videoTrackRef.current.applyConstraints({ 
                      advanced: [{ focusMode: 'continuous' }] 
                  } as any).catch(() => {});
              } catch (e) {}
          }
      }, 2000); // Check every 2 seconds

      return () => clearInterval(focusInterval);
  }, [hasCameraPermission]);

  // 3. Decoding Loop (Heartbeat)
  useEffect(() => {
    if (!hasCameraPermission || !codeReaderRef.current) return;

    let stopLoop = false;

    const loop = async () => {
      if (stopLoop) return;

      // Heartbeat: Always request next frame to keep thread alive
      animationFrameRef.current = requestAnimationFrame(loop);

      if (!activeRef.current) return;
      if (isBusyRef.current) return;

      const video = videoRef.current;
      if (!video || video.readyState !== video.HAVE_ENOUGH_DATA) return;

      try {
        isBusyRef.current = true; // Lock

        if (codeReaderRef.current) {
            // @ts-ignore
            const result = await codeReaderRef.current.decode(video);
            
            if (activeRef.current && result) {
                onScan(result.getText(), result.getBarcodeFormat().toString());
            }
        }
      } catch (err) {
        // NotFoundException is expected
      } finally {
        isBusyRef.current = false; // Unlock
      }
    };

    loop();

    return () => {
      stopLoop = true;
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [hasCameraPermission, onScan]);


  const handleZoom = (newZoom: number) => {
    if (!zoomCap) return;
    
    // Clamp value
    const clamped = Math.min(Math.max(newZoom, zoomCap.min), zoomCap.max);
    
    setZoom(clamped);
    
    // Notify parent to store in session
    if (onZoomChange) {
        onZoomChange(clamped);
    }

    if (videoTrackRef.current) {
      try {
        const constraints = { advanced: [{ zoom: clamped }] };
        videoTrackRef.current.applyConstraints(constraints as any);
      } catch (err) {
        console.error("Zoom failed", err);
      }
    }
  };

  if (hasCameraPermission === false) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-red-400 p-6 text-center bg-slate-900">
        <AlertCircle size={48} className="mb-4" />
        <p className="text-lg font-semibold">카메라 오류</p>
        <p className="text-sm mt-2 text-slate-400">카메라 권한을 확인해주세요.</p>
        <button onClick={() => window.location.reload()} className="mt-4 bg-slate-700 px-4 py-2 rounded">새로고침</button>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-black flex flex-col overflow-hidden">
      <video 
        ref={videoRef} 
        className="w-full h-full object-cover" 
        muted 
        playsInline 
        autoPlay
      />
      
      {/* Scan Guide Overlay */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          {/* Laser Line - Vertical */}
          <div className="absolute w-0.5 h-full bg-red-500/80 shadow-[0_0_8px_rgba(239,68,68,0.8)]"></div>
          
          {/* Visual Guide Box - Dynamic Size based on S21 Mode */}
          <div className={`
            ${s21Mode 
                ? 'w-[70px] h-[110px] landscape:w-[110px] landscape:h-[70px]' 
                : 'w-[140px] h-[220px] landscape:w-[220px] landscape:h-[140px]'
            } 
            border-2 border-white/40 rounded-lg shadow-[0_0_0_9999px_rgba(0,0,0,0.4)] box-border relative transition-all duration-300
          `}>
              <div className="absolute top-0 left-0 w-3 h-3 border-t-2 border-l-2 border-emerald-400 -mt-0.5 -ml-0.5 rounded-tl-sm"></div>
              <div className="absolute top-0 right-0 w-3 h-3 border-t-2 border-r-2 border-emerald-400 -mt-0.5 -mr-0.5 rounded-tr-sm"></div>
              <div className="absolute bottom-0 left-0 w-3 h-3 border-b-2 border-l-2 border-emerald-400 -mb-0.5 -ml-0.5 rounded-bl-sm"></div>
              <div className="absolute bottom-0 right-0 w-3 h-3 border-b-2 border-r-2 border-emerald-400 -mb-0.5 -mr-0.5 rounded-br-sm"></div>
          </div>
      </div>

      {/* Mode Indicator */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 pointer-events-none z-20 whitespace-nowrap">
         <div className="flex items-center gap-1 text-[10px] text-white/70 bg-black/40 px-3 py-1 rounded-full backdrop-blur-sm border border-white/10">
            <Scan size={12} className="text-emerald-400"/>
            <span>ITF 바코드를 박스 안에 맞춰주세요</span>
         </div>
         {s21Mode ? (
             <span className="text-[10px] text-emerald-400 font-bold bg-emerald-900/60 px-2 py-0.5 rounded border border-emerald-500/30">
                 S21 모드 ON (고정 2.0x)
             </span>
         ) : (
            <span className="text-[10px] text-slate-400 font-bold bg-slate-800/60 px-2 py-0.5 rounded border border-slate-500/30">
                일반 모드 (고정 2.0x)
            </span>
         )}
      </div>
    </div>
  );
});