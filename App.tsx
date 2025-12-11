import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Scanner } from './components/Scanner';
import { FeedbackOverlay } from './components/FeedbackOverlay';
import { playSuccessSound, playErrorSound, speakMessage } from './services/audioService';
import { ScannedRecord, FeedbackState, RecordType } from './types';
import { Download, Trash2, List, Camera, Power, Copy, LogOut, Check, FileText, Settings } from 'lucide-react';

const LOG_STORAGE_KEY = 'itf_scanner_logs';

export default function App() {
  const [logs, setLogs] = useState<ScannedRecord[]>([]);
  const [view, setView] = useState<'scan' | 'list'>('scan');
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [isPaused, setIsPaused] = useState(false);

  // App State
  const [isStarted, setIsStarted] = useState(false);
  const [showRouteModal, setShowRouteModal] = useState(false);
  const [routeName, setRouteName] = useState('');

  const lastScannedCode = useRef<string | null>(null);
  const lastScanTime = useRef<number>(0);

  // Critical: Instant lookup for duplicates to avoid React State delays
  const scannedCodesRef = useRef<Set<string>>(new Set());
  // Critical: Synchronous lock to prevent re-entry during feedback
  const isProcessing = useRef<boolean>(false);

  // Load logs on mount
  useEffect(() => {
    const saved = localStorage.getItem(LOG_STORAGE_KEY);
    if (saved) {
      try {
        const parsedLogs: ScannedRecord[] = JSON.parse(saved);
        setLogs(parsedLogs);
        // Sync Ref with loaded logs for instant duplicate checks
        parsedLogs.forEach(log => {
          if (log.type === 'SCAN') {
            scannedCodesRef.current.add(log.code);
          }
        });
      } catch (e) {
        console.error("Failed to parse logs", e);
      }
    }
  }, []);

  // Save logs on change
  useEffect(() => {
    localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(logs));
  }, [logs]);

  // --- Handlers ---

  const handleStartClick = () => {
    // Initialize Audio Context on user gesture
    const AudioContextClass = (window.AudioContext || (window as any).webkitAudioContext);
    const ctx = new AudioContextClass();
    ctx.resume().then(() => {
      setShowRouteModal(true);
    });
  };

  const handleViewRecordsClick = () => {
    // Enter view-only mode
    setIsStarted(true); // Temporarily act as started to show UI
    setView('list');    // Directly go to list
    setRouteName('');   // No active route
  };

  const handleRouteConfirm = () => {
    if (!routeName.trim()) {
      alert("라우트명을 입력해주세요.");
      return;
    }

    // Add Route Start Header with Down Arrow
    const headerRecord: ScannedRecord = {
      id: crypto.randomUUID(),
      type: 'INFO',
      code: `(${routeName}) 시작 ▼`,
      timestamp: Date.now()
    };

    setLogs(prev => [headerRecord, ...prev]);
    setIsStarted(true);
    setView('scan'); // Ensure we start at scan view
    setShowRouteModal(false);
  };

  const handleEndScan = () => {
    if (confirm("스캔을 종료하시겠습니까? 메인 화면으로 돌아갑니다.")) {
      // Add Route End Footer with Up Arrow only if we had an active route
      if (routeName) {
        const footerRecord: ScannedRecord = {
          id: crypto.randomUUID(),
          type: 'INFO',
          code: `(${routeName}) 종료 ▲`,
          timestamp: Date.now()
        };
        setLogs(prev => [footerRecord, ...prev]);
      }

      // Reset State
      setIsStarted(false);
      setRouteName('');
      setView('scan');
      // Note: We do NOT clear scannedCodesRef here because users might want to keep the history in the list.
    }
  };

  // Stable error handler for React.memo
  const handleError = useCallback((err: string) => {
    console.log(err);
  }, []);

  const handleScan = useCallback((rawCode: string, format: string) => {
    // 1. Synchronous Gate Checks
    if (isProcessing.current || isPaused) return;

    // Trim whitespace to prevent ghost errors
    const code = rawCode.trim();

    // Throttle exact same reads (hardware bounce)
    const now = Date.now();
    if (code === lastScannedCode.current && now - lastScanTime.current < 1000) {
      return;
    }

    lastScannedCode.current = code;
    lastScanTime.current = now;

    // --- Validation Logic (Executed BEFORE any state update) ---

    // 2. Check Numeric
    const isNumeric = /^\d+$/.test(code);

    if (!isNumeric) {
      triggerFeedback('error', '바코드 형식 오류', true);
      return;
    }

    // 3. Check Length (Must be 14)
    if (code.length !== 14) {
      triggerFeedback('error', '자릿수 오류', true);
      return;
    }

    // 4. Check Duplicate (Using Ref for Instant O(1) Check)
    if (scannedCodesRef.current.has(code)) {
      triggerFeedback('error', '중복 스캔', true);
      return;
    }

    // --- Success ---
    // Immediately lock processing to prevent subsequent frames from entering
    isProcessing.current = true;

    // Final Safety Check:
    // Ensure that between validation and here, nothing weird happened (rare race condition)
    if (code.length !== 14 || scannedCodesRef.current.has(code)) {
      isProcessing.current = false;
      return;
    }

    triggerFeedback('success', '딩동! OK', false);

    const newRecord: ScannedRecord = {
      id: crypto.randomUUID(),
      type: 'SCAN',
      code,
      format: 'ITF', // Force label as ITF since we validated structure
      timestamp: now
    };

    // Update State and Ref
    scannedCodesRef.current.add(code);
    setLogs(prev => [newRecord, ...prev]);

  }, [isPaused]);

  const triggerFeedback = (type: 'success' | 'error', message: string, speak: boolean) => {
    // Lock immediately
    isProcessing.current = true;
    setFeedback({ type, message });
    setIsPaused(true);

    if (type === 'success') {
      playSuccessSound();
    } else {
      playErrorSound();
      if (speak) speakMessage(message);
    }

    setTimeout(() => {
      setFeedback(null);
      setIsPaused(false);
      // Unlock after feedback is done
      isProcessing.current = false;
    }, 600);
  };

  // --- Export / Actions ---

  const handleDownload = () => {
    if (logs.length === 0) return;

    // Reverse logs to get chronological order (Oldest -> Newest)
    const chronologicalLogs = [...logs].reverse();
    const textContent = chronologicalLogs.map(l => l.code).join('\n');

    // Fix: Add BOM (\uFEFF) for UTF-8 compatibility
    const blob = new Blob(['\uFEFF' + textContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `SCAN_${new Date().toISOString().slice(0, 10)}_${routeName || 'Log'}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopy = async () => {
    if (logs.length === 0) return;

    // Reverse logs to get chronological order (Oldest -> Newest)
    const chronologicalLogs = [...logs].reverse();
    const textContent = chronologicalLogs.map(l => l.code).join('\n');

    try {
      await navigator.clipboard.writeText(textContent);
      alert("클립보드에 복사되었습니다.");
    } catch (err) {
      alert("복사에 실패했습니다.");
    }
  };

  const clearLogs = () => {
    if (confirm('기록을 모두 삭제하시겠습니까?')) {
      setLogs([]);
      scannedCodesRef.current.clear(); // Important: Clear the duplicate checker
      lastScannedCode.current = null;
    }
  };

  const lastScan = logs.find(l => l.type === 'SCAN');

  // --- Render ---

  if (!isStarted) {
    return (
      <div className="h-[100dvh] w-full flex flex-col items-center justify-center bg-slate-900 text-white p-6 relative">
        <div className="text-center space-y-4 mb-10">
          <h1 className="text-xl md:text-2xl font-bold text-emerald-400 whitespace-pre-line leading-relaxed break-keep">
            (주)피엘지 - 2025<br />국토부 디지털물류 실증 웹앱
          </h1>
        </div>

        <div className="flex flex-col gap-6 items-center w-full max-w-xs">
          <button
            onClick={handleStartClick}
            className="group relative flex flex-col items-center justify-center w-40 h-40 bg-slate-800 rounded-full border-4 border-emerald-500/30 hover:border-emerald-500 hover:bg-slate-700 transition-all active:scale-95 shadow-[0_0_30px_rgba(16,185,129,0.2)]"
          >
            <Power size={48} className="text-emerald-400 group-hover:text-emerald-300 mb-2" />
            <span className="text-sm font-semibold text-emerald-100">시작하기</span>
          </button>

          <button
            onClick={handleViewRecordsClick}
            className="flex items-center justify-center gap-2 text-slate-400 hover:text-white mt-2 py-2 px-4 rounded-lg hover:bg-slate-800 transition-colors w-full"
          >
            <FileText size={16} />
            <span className="text-sm">기존 기록 보기</span>
          </button>
        </div>

        {showRouteModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm px-4">
            <div className="bg-slate-800 rounded-xl w-full max-w-sm p-6 border border-slate-700 shadow-2xl">
              <h3 className="text-lg font-bold text-white mb-4">라우트명 입력</h3>
              <input
                type="text"
                value={routeName}
                onChange={(e) => setRouteName(e.target.value)}
                placeholder="예: 서울-강남-01"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-emerald-500 transition-colors mb-6"
                autoFocus
              />
              <div className="flex gap-3">
                <button
                  onClick={() => setShowRouteModal(false)}
                  className="flex-1 py-3 rounded-lg bg-slate-700 text-slate-300 font-medium"
                >
                  취소
                </button>
                <button
                  onClick={handleRouteConfirm}
                  className="flex-1 py-3 rounded-lg bg-emerald-600 text-white font-bold hover:bg-emerald-500"
                >
                  확인
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-[100dvh] w-full flex flex-col bg-slate-900 text-slate-100 overflow-hidden font-sans">
      {/* Header */}
      <header className="min-h-[3.5rem] bg-slate-800 border-b border-slate-700 flex items-center justify-between px-3 py-1 z-10 shadow-md shrink-0">
        <h1 className="font-bold text-xs text-emerald-400 flex-1 leading-tight mr-2 break-keep whitespace-normal">
          (주)피엘지 - 2025 국토부 디지털물류 실증 웹앱
        </h1>
        <div className="flex items-center gap-2 shrink-0">
          <div className="text-xs text-slate-400 bg-slate-700 px-2 py-1 rounded">
            {logs.filter(l => l.type === 'SCAN').length} 건
          </div>
          <button
            onClick={handleEndScan}
            className="bg-red-900/80 hover:bg-red-800 text-red-100 text-xs px-3 py-1.5 rounded-md flex items-center gap-1 transition-colors"
          >
            <LogOut size={12} />
            종료
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 relative overflow-hidden">
        {view === 'scan' ? (
          <>
            <Scanner
              onScan={handleScan}
              onError={handleError}
              isPaused={isPaused}
            />
            <FeedbackOverlay state={feedback} />
          </>
        ) : (
          <div className="h-full flex flex-col">
            <div className="flex-1 overflow-y-auto p-4 space-y-3 pb-4">
              {logs.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-64 text-slate-500">
                  <List size={48} className="mb-2 opacity-50" />
                  <p>스캔된 기록이 없습니다.</p>
                </div>
              ) : (
                // REVERSE the logs array to show Chronological Order (Oldest -> Newest)
                [...logs].reverse().map((log) => {
                  if (log.type === 'INFO') {
                    return (
                      <div key={log.id} className="flex items-center justify-center py-3">
                        <div className="h-[1px] bg-emerald-900/50 w-8 mx-2"></div>
                        <span className="text-xs text-emerald-400 font-bold bg-emerald-900/20 px-3 py-1 rounded-full border border-emerald-800/50">
                          {log.code}
                        </span>
                        <div className="h-[1px] bg-emerald-900/50 w-8 mx-2"></div>
                      </div>
                    )
                  }
                  return (
                    <div key={log.id} className="bg-slate-800 p-4 rounded-lg border border-slate-700 shadow-sm flex justify-between items-center animate-in fade-in slide-in-from-bottom-2 duration-300">
                      <div>
                        <p className="text-2xl font-mono text-white tracking-widest">{log.code}</p>
                        <p className="text-xs text-slate-400 mt-1">{new Date(log.timestamp).toLocaleTimeString()}</p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </main>

      {/* Footer / Controls */}
      <footer className="h-auto min-h-[5rem] bg-slate-800 border-t border-slate-700 shrink-0 z-20 pb-safe">
        <div className="grid grid-cols-3 gap-1 px-2 py-2 h-full">
          <button
            onClick={() => setView('scan')}
            className={`flex flex-col items-center justify-center rounded-lg transition-all py-1 ${view === 'scan' ? 'bg-emerald-600/20 text-emerald-400' : 'text-slate-400 hover:bg-slate-700'}`}
          >
            <Camera size={24} />
            <span className="text-xs mt-1 font-medium">스캔</span>
          </button>

          <button
            onClick={() => setView('list')}
            className={`flex flex-col items-center justify-center rounded-lg transition-all py-1 ${view === 'list' ? 'bg-emerald-600/20 text-emerald-400' : 'text-slate-400 hover:bg-slate-700'}`}
          >
            <List size={24} />
            <span className="text-xs mt-1 font-medium">기록</span>
          </button>

          {view === 'list' ? (
            // List View Buttons (Action Mode)
            <div className="flex flex-col gap-1.5 justify-center">
              <button
                onClick={handleDownload}
                className="flex-1 bg-blue-600 hover:bg-blue-500 text-white rounded flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50 text-[11px] font-bold"
                disabled={logs.length === 0}
              >
                <Download size={14} /> 저장
              </button>
              <div className="flex gap-1 h-1/2">
                <button
                  onClick={handleCopy}
                  className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded flex items-center justify-center gap-1 transition-colors text-[10px]"
                >
                  <Copy size={12} /> 클립보드로 복사
                </button>
                <button
                  onClick={clearLogs}
                  className="flex-1 bg-red-900/50 hover:bg-red-900 text-red-200 border border-red-900 rounded flex items-center justify-center gap-1 transition-colors text-[10px]"
                >
                  <Trash2 size={12} /> 초기화
                </button>
              </div>
            </div>
          ) : (
            // Scan View Footer (Recent Scan Display)
            <div className="flex flex-col items-center justify-center text-slate-500 bg-slate-800/50 rounded-lg p-1 relative overflow-hidden">
              <div className="absolute top-1 left-2 flex items-center gap-1 text-[10px] text-slate-400">
                <Check size={10} />
                <span>최근</span>
              </div>
              {lastScan ? (
                <span className="text-4xl font-mono font-black text-emerald-400 tracking-tighter leading-none mt-2">
                  {lastScan.code.slice(-4)}
                </span>
              ) : (
                <span className="text-2xl text-slate-700 font-bold mt-2">----</span>
              )}
            </div>
          )}
        </div>
      </footer>
    </div>
  );
}