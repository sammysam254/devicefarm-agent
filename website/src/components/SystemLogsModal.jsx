import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';

export default function SystemLogsModal({ isOpen, onClose, initialBindingFilter = '' }) {
  const [logs, setLogs] = useState([]);
  const [filterLevel, setFilterLevel] = useState('ALL');
  const [filterBinding, setFilterBinding] = useState(initialBindingFilter);
  const [searchQuery, setSearchQuery] = useState('');
  const [isPaused, setIsPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const logContainerRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;

    // Ephemeral realtime broadcast channel for near-zero egress
    const channel = supabase.channel('system_logs_broadcast', {
      config: { broadcast: { self: true } },
    });

    channel
      .on('broadcast', { event: 'log_batch' }, ({ payload }) => {
        if (isPaused) return;
        if (payload && Array.isArray(payload.logs)) {
          setLogs(prev => {
            const next = [...prev, ...payload.logs];
            // Keep maximum 300 logs in browser memory
            return next.slice(-300);
          });
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [isOpen, isPaused]);

  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  if (!isOpen) return null;

  const filteredLogs = logs.filter(log => {
    if (filterLevel !== 'ALL' && log.level?.toUpperCase() !== filterLevel) return false;
    if (filterBinding && log.bindingCode && !log.bindingCode.toLowerCase().includes(filterBinding.toLowerCase())) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchMsg = log.message?.toLowerCase().includes(q);
      const matchBinding = log.bindingCode?.toLowerCase().includes(q);
      if (!matchMsg && !matchBinding) return false;
    }
    return true;
  });

  const getLevelColor = (lvl = '') => {
    switch (lvl.toUpperCase()) {
      case 'ERROR': return 'text-red-400 bg-red-950/60 border-red-800';
      case 'WARN': return 'text-amber-400 bg-amber-950/60 border-amber-800';
      case 'SUCCESS': return 'text-emerald-400 bg-emerald-950/60 border-emerald-800';
      default: return 'text-sky-400 bg-sky-950/60 border-sky-800';
    }
  };

  const handleCopyLogs = () => {
    const text = filteredLogs.map(l => `[${l.timestamp}] [${l.bindingCode || 'AGENT'}] [${l.level?.toUpperCase()}]: ${l.message}`).join('\n');
    navigator.clipboard.writeText(text);
    alert('📋 Logs copied to clipboard!');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fadeIn">
      <div className="bg-slate-900 border border-slate-700/80 w-full max-w-5xl rounded-2xl shadow-2xl flex flex-col overflow-hidden h-[85vh] text-slate-100 font-sans">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 bg-slate-950/80 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">📜</span>
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                Live System Logs
                <span className={`inline-block w-2.5 h-2.5 rounded-full ${isPaused ? 'bg-amber-500' : 'bg-emerald-500 animate-pulse'}`}></span>
              </h2>
              <p className="text-xs text-slate-400">Real-time low-egress broadcast from connected DeviceFarm agents</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsPaused(!isPaused)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                isPaused
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 hover:bg-amber-500/30'
                  : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
              }`}
            >
              {isPaused ? '▶ Resume Feed' : '⏸ Pause'}
            </button>
            <button
              onClick={() => setLogs([])}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700 transition"
            >
              🗑 Clear
            </button>
            <button
              onClick={handleCopyLogs}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-sky-500/20 text-sky-300 border border-sky-500/40 hover:bg-sky-500/30 transition"
            >
              📋 Copy Logs
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Filters Toolbar */}
        <div className="px-6 py-3 border-b border-slate-800/80 bg-slate-900/90 flex flex-wrap items-center gap-3 text-xs">
          <div className="flex items-center gap-1.5 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 flex-1 min-w-[200px]">
            <span className="text-slate-500">🔍</span>
            <input
              type="text"
              placeholder="Search logs message or binding..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-transparent border-none text-white focus:outline-none w-full text-xs"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-slate-400 font-medium">Level:</span>
            {['ALL', 'INFO', 'WARN', 'ERROR'].map(lvl => (
              <button
                key={lvl}
                onClick={() => setFilterLevel(lvl)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-bold border transition ${
                  filterLevel === lvl
                    ? 'bg-sky-500 text-slate-950 border-sky-400 shadow-sm'
                    : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-white'
                }`}
              >
                {lvl}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-2 text-slate-400 cursor-pointer select-none ml-auto">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="rounded bg-slate-950 border-slate-700 text-sky-500 focus:ring-0"
            />
            <span>Auto-scroll</span>
          </label>
        </div>

        {/* Terminal Console Output */}
        <div
          ref={logContainerRef}
          className="flex-1 bg-black/90 p-4 font-mono text-xs overflow-y-auto space-y-1 select-text scrollbar-thin scrollbar-thumb-slate-800"
        >
          {filteredLogs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-500 py-12">
              <span className="text-3xl mb-2">📡</span>
              <p>Waiting for live system logs from agents...</p>
              <p className="text-[11px] text-slate-600 mt-1">Logs will appear here instantly when background agents perform actions.</p>
            </div>
          ) : (
            filteredLogs.map(l => (
              <div key={l.id} className="flex items-start gap-2 hover:bg-slate-900/60 px-2 py-0.5 rounded transition">
                <span className="text-slate-500 whitespace-nowrap select-none">{l.timestamp ? new Date(l.timestamp).toLocaleTimeString() : ''}</span>
                {l.bindingCode && (
                  <span className="px-1.5 py-0.2 rounded text-[10px] font-semibold bg-slate-800 text-slate-300 border border-slate-700/60 whitespace-nowrap">
                    {l.bindingCode}
                  </span>
                )}
                <span className={`px-1.5 py-0.2 rounded text-[10px] font-bold border whitespace-nowrap ${getLevelColor(l.level)}`}>
                  {l.level?.toUpperCase() || 'INFO'}
                </span>
                <span className="text-slate-200 break-all">{l.message}</span>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-2.5 border-t border-slate-800 bg-slate-950 flex items-center justify-between text-[11px] text-slate-500">
          <div>
            Showing <strong className="text-slate-300">{filteredLogs.length}</strong> of <strong className="text-slate-300">{logs.length}</strong> loaded logs
          </div>
          <div>
            Near-zero Supabase Egress (Ephemeral WebSocket Broadcast)
          </div>
        </div>

      </div>
    </div>
  );
}
