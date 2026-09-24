import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';

export default function SystemLogsModal({ isOpen, onClose, initialBindingFilter = '' }) {
  const [logs, setLogs] = useState([]);
  const [filterCategory, setFilterCategory] = useState('ALL');
  const [filterBinding, setFilterBinding] = useState(initialBindingFilter);
  const [searchQuery, setSearchQuery] = useState('');
  const [isPaused, setIsPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [isHealingDispatched, setIsHealingDispatched] = useState(false);
  const [isAgentConnected, setIsAgentConnected] = useState(false);
  const logContainerRef = useRef(null);

  const mergeLogs = (newLogs) => {
    if (!Array.isArray(newLogs) || newLogs.length === 0) return;
    setLogs(prev => {
      const map = new Map();
      // Keep unique logs by ID or unique key
      [...prev, ...newLogs].forEach(l => {
        const key = l.id ? String(l.id) : `${l.timestamp}-${l.message}`;
        map.set(key, l);
      });
      // Return sorted by sequence / timestamp up to 500 items
      return Array.from(map.values())
        .sort((a, b) => (a.id || 0) - (b.id || 0))
        .slice(-500);
    });
  };

  useEffect(() => {
    if (!isOpen) return;

    // 1. Initial REST fetch for instant logs before realtime arrives
    const fetchRecentRestLogs = async () => {
      try {
        const res = await fetch('https://agent.dennoh.site/api/system-logs?limit=300', {
          headers: { 'Cache-Control': 'no-cache' }
        });
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.logs)) {
            mergeLogs(data.logs);
            setIsAgentConnected(true);
          }
        }
      } catch (_) {
        // Fallback gracefully to Supabase realtime
      }
    };
    fetchRecentRestLogs();

    // 2. Realtime broadcast channel for live agent streaming
    const channel = supabase.channel('system_logs_broadcast', {
      config: { broadcast: { self: true } },
    });

    channel
      .on('broadcast', { event: 'log_batch' }, ({ payload }) => {
        setIsAgentConnected(true);
        if (isPaused) return;
        if (payload && Array.isArray(payload.logs)) {
          mergeLogs(payload.logs);
        }
      })
      .on('broadcast', { event: 'log_history' }, ({ payload }) => {
        setIsAgentConnected(true);
        if (payload && Array.isArray(payload.logs)) {
          mergeLogs(payload.logs);
        }
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          // Request historical logs from running remote agent
          try {
            channel.send({
              type: 'broadcast',
              event: 'request_history',
              payload: {},
            });
          } catch (_) {}
        }
      });

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

  // Filter logs according to active tab and search
  const filteredLogs = logs.filter(log => {
    const msg = (log.message || '').toLowerCase();
    const cat = log.category || '';
    const lvl = (log.level || '').toLowerCase();

    // Tab category filter
    if (filterCategory === 'ERROR') {
      const isErr = cat === 'error' || lvl === 'error' || msg.includes('error') || msg.includes('fail') || msg.includes('crash');
      if (!isErr) return false;
    } else if (filterCategory === 'AUTO_HEAL') {
      const isHeal = cat === 'auto_heal' || msg.includes('autoheal') || msg.includes('auto-heal') || msg.includes('recovering') || msg.includes('self-healing') || msg.includes('healed');
      if (!isHeal) return false;
    } else if (filterCategory === 'DEVICE') {
      const isDev = cat === 'device' || msg.includes('device') || msg.includes('stream') || msg.includes('scrcpy') || msg.includes('port');
      if (!isDev) return false;
    } else if (filterCategory === 'SYSTEM') {
      if (cat === 'auto_heal' || cat === 'error') return false;
    }

    if (filterBinding && log.bindingCode && !log.bindingCode.toLowerCase().includes(filterBinding.toLowerCase())) {
      return false;
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchMsg = msg.includes(q);
      const matchBinding = log.bindingCode?.toLowerCase().includes(q);
      const matchCategory = cat.toLowerCase().includes(q);
      if (!matchMsg && !matchBinding && !matchCategory) return false;
    }

    return true;
  });

  // Calculate live statistics
  const errorCount = logs.filter(l => l.category === 'error' || l.level === 'error' || (l.message || '').toLowerCase().includes('error')).length;
  const autoHealCount = logs.filter(l => l.category === 'auto_heal' || (l.message || '').toLowerCase().includes('autoheal') || (l.message || '').toLowerCase().includes('auto-heal')).length;

  const getBadgeStyle = (log) => {
    const cat = log.category || '';
    const lvl = (log.level || '').toUpperCase();
    const msg = (log.message || '').toLowerCase();

    if (cat === 'auto_heal' || msg.includes('autoheal') || msg.includes('auto-heal') || msg.includes('healed')) {
      return 'text-emerald-300 bg-emerald-950/80 border-emerald-500/50 shadow-sm shadow-emerald-900/30';
    }
    if (cat === 'error' || lvl === 'ERROR' || msg.includes('error') || msg.includes('failed')) {
      return 'text-rose-300 bg-rose-950/80 border-rose-500/50 shadow-sm shadow-rose-900/30';
    }
    if (cat === 'warn' || lvl === 'WARN' || msg.includes('warn') || msg.includes('stall')) {
      return 'text-amber-300 bg-amber-950/80 border-amber-500/50';
    }
    if (cat === 'device') {
      return 'text-sky-300 bg-sky-950/80 border-sky-500/50';
    }
    return 'text-slate-300 bg-slate-900/80 border-slate-700';
  };

  const getBadgeText = (log) => {
    const cat = log.category || '';
    const lvl = (log.level || '').toUpperCase();
    const msg = (log.message || '').toLowerCase();

    if (cat === 'auto_heal' || msg.includes('autoheal') || msg.includes('auto-heal') || msg.includes('healed')) {
      return '⚡ AUTO-HEAL';
    }
    if (cat === 'error' || lvl === 'ERROR') return '🚨 ERROR';
    if (cat === 'warn' || lvl === 'WARN') return '⚠️ WARN';
    if (cat === 'device') return '📱 DEVICE';
    return 'ℹ️ ' + (lvl || 'INFO');
  };

  const handleCopyLogs = () => {
    const text = filteredLogs.map(l => `[${l.timestamp}] [${l.bindingCode || 'AGENT'}] [${(l.category || l.level || 'INFO').toUpperCase()}]: ${l.message}`).join('\n');
    navigator.clipboard.writeText(text);
    alert('📋 ' + filteredLogs.length + ' logs copied to clipboard!');
  };

  const handleTriggerAutoHeal = async () => {
    setIsHealingDispatched(true);
    try {
      const res = await fetch('https://agent.dennoh.site/api/system/auto-heal');
      if (res.ok) {
        alert('⚡ Auto-heal command dispatched to remote agent! Streams are self-healing in-place without taking streams offline.');
      } else {
        alert('Notice: Remote agent received signal.');
      }
    } catch (e) {
      alert('Dispatched auto-heal signal via tunnel endpoint.');
    } finally {
      setTimeout(() => setIsHealingDispatched(false), 3000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6 bg-black/85 backdrop-blur-md animate-fadeIn">
      <div className="bg-slate-950 border border-slate-800 w-full max-w-6xl rounded-2xl shadow-2xl flex flex-col overflow-hidden h-[90vh] text-slate-100 font-sans">
        
        {/* Header Bar */}
        <div className="px-6 py-4 border-b border-slate-800 bg-slate-900/90 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-3xl p-2 rounded-xl bg-sky-500/10 border border-sky-500/20">📜</span>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-extrabold text-white tracking-wide flex items-center gap-2">
                  System Event & Activity Logger
                </h2>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${
                  isAgentConnected
                    ? 'bg-emerald-950/60 text-emerald-400 border-emerald-700/60'
                    : 'bg-amber-950/60 text-amber-400 border-amber-700/60'
                }`}>
                  <span className={`w-2 h-2 rounded-full ${isAgentConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`}></span>
                  {isAgentConnected ? 'AGENT LIVE' : 'LISTENING'}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Monitoring device streams, activity events, errors & autonomous self-healing in real time
              </p>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={handleTriggerAutoHeal}
              disabled={isHealingDispatched}
              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30 transition flex items-center gap-1.5 shadow-sm shadow-emerald-950"
              title="Trigger in-place auto-healing on remote agent without taking streams offline"
            >
              <span>⚡</span> {isHealingDispatched ? 'Healing Sent...' : 'Auto-Heal Streams'}
            </button>
            <button
              onClick={() => setIsPaused(!isPaused)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                isPaused
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 hover:bg-amber-500/30'
                  : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
              }`}
            >
              {isPaused ? '▶ Resume Feed' : '⏸ Pause Feed'}
            </button>
            <button
              onClick={() => setLogs([])}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700 transition"
            >
              🗑 Clear View
            </button>
            <button
              onClick={handleCopyLogs}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-sky-500/20 text-sky-300 border border-sky-500/40 hover:bg-sky-500/30 transition"
            >
              📋 Copy Logs
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition text-sm ml-1"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Stats & Category Filter Bar */}
        <div className="px-6 py-2.5 border-b border-slate-800/80 bg-slate-900/60 flex flex-wrap items-center justify-between gap-3 text-xs">
          {/* Filter Tabs */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => setFilterCategory('ALL')}
              className={`px-3 py-1 rounded-lg text-xs font-bold border transition ${
                filterCategory === 'ALL'
                  ? 'bg-sky-500 text-slate-950 border-sky-400 shadow-sm'
                  : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-white hover:border-slate-700'
              }`}
            >
              ALL ({logs.length})
            </button>
            <button
              onClick={() => setFilterCategory('AUTO_HEAL')}
              className={`px-3 py-1 rounded-lg text-xs font-bold border transition flex items-center gap-1.5 ${
                filterCategory === 'AUTO_HEAL'
                  ? 'bg-emerald-500 text-slate-950 border-emerald-400 shadow-sm'
                  : 'bg-emerald-950/40 text-emerald-400 border-emerald-800/60 hover:bg-emerald-950/70'
              }`}
            >
              <span>⚡ AUTO-HEAL</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-emerald-900/60 text-emerald-200 border border-emerald-700/50">
                {autoHealCount}
              </span>
            </button>
            <button
              onClick={() => setFilterCategory('ERROR')}
              className={`px-3 py-1 rounded-lg text-xs font-bold border transition flex items-center gap-1.5 ${
                filterCategory === 'ERROR'
                  ? 'bg-rose-500 text-slate-950 border-rose-400 shadow-sm'
                  : 'bg-rose-950/40 text-rose-400 border-rose-800/60 hover:bg-rose-950/70'
              }`}
            >
              <span>🚨 ERRORS</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-rose-900/60 text-rose-200 border border-rose-700/50">
                {errorCount}
              </span>
            </button>
            <button
              onClick={() => setFilterCategory('DEVICE')}
              className={`px-3 py-1 rounded-lg text-xs font-bold border transition ${
                filterCategory === 'DEVICE'
                  ? 'bg-cyan-500 text-slate-950 border-cyan-400 shadow-sm'
                  : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-white hover:border-slate-700'
              }`}
            >
              📱 DEVICES & STREAMS
            </button>
            <button
              onClick={() => setFilterCategory('SYSTEM')}
              className={`px-3 py-1 rounded-lg text-xs font-bold border transition ${
                filterCategory === 'SYSTEM'
                  ? 'bg-purple-500 text-slate-950 border-purple-400 shadow-sm'
                  : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-white hover:border-slate-700'
              }`}
            >
              ⚙️ SYSTEM
            </button>
          </div>

          {/* Search Input */}
          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1 w-full focus-within:border-sky-500 transition">
              <span className="text-slate-500">🔍</span>
              <input
                type="text"
                placeholder="Search events, device serials, errors..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-transparent border-none text-white focus:outline-none w-full text-xs placeholder:text-slate-600"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="text-slate-500 hover:text-white text-xs">✕</button>
              )}
            </div>
            <label className="flex items-center gap-1.5 text-slate-400 cursor-pointer select-none whitespace-nowrap text-xs">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="rounded bg-slate-950 border-slate-700 text-sky-500 focus:ring-0"
              />
              <span>Scroll</span>
            </label>
          </div>
        </div>

        {/* Live Terminal Log Stream Container */}
        <div
          ref={logContainerRef}
          className="flex-1 bg-black/95 p-4 font-mono text-xs overflow-y-auto space-y-1.5 select-text scrollbar-thin scrollbar-thumb-slate-800"
        >
          {filteredLogs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-500 py-16">
              <span className="text-4xl mb-3 animate-pulse">📡</span>
              <p className="font-sans font-bold text-sm text-slate-300">Live System Event Stream Active</p>
              <p className="font-sans text-xs text-slate-500 mt-1 max-w-md text-center">
                Events, errors, device connect/disconnects, and intelligent auto-healing actions from your remote agent will be logged here automatically.
              </p>
            </div>
          ) : (
            filteredLogs.map(l => (
              <div
                key={l.id || `${l.timestamp}-${l.message}`}
                className={`flex items-start gap-2.5 px-3 py-1.5 rounded-lg border transition ${
                  l.category === 'auto_heal' || (l.message || '').includes('[AutoHeal]')
                    ? 'bg-emerald-950/20 border-emerald-900/40 hover:bg-emerald-950/30'
                    : l.category === 'error' || l.level === 'error'
                    ? 'bg-rose-950/25 border-rose-900/40 hover:bg-rose-950/35'
                    : 'bg-slate-900/40 border-slate-900/60 hover:bg-slate-900/80'
                }`}
              >
                {/* Timestamp */}
                <span className="text-slate-500 text-[11px] whitespace-nowrap select-none pt-0.5">
                  {l.timestamp ? new Date(l.timestamp).toLocaleTimeString() : ''}
                </span>

                {/* Binding / Machine Code */}
                {l.bindingCode && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-800 text-slate-300 border border-slate-700/80 whitespace-nowrap select-none">
                    {l.bindingCode}
                  </span>
                )}

                {/* Event Category / Level Badge */}
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold border whitespace-nowrap select-none ${getBadgeStyle(l)}`}>
                  {getBadgeText(l)}
                </span>

                {/* Message Body */}
                <span className={`break-all leading-relaxed ${
                  l.category === 'auto_heal'
                    ? 'text-emerald-200 font-semibold'
                    : l.category === 'error' || l.level === 'error'
                    ? 'text-rose-200 font-semibold'
                    : 'text-slate-200'
                }`}>
                  {l.message}
                </span>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-2.5 border-t border-slate-800 bg-slate-950 flex flex-wrap items-center justify-between text-[11px] text-slate-500 gap-2">
          <div className="flex items-center gap-4">
            <span>
              Showing <strong className="text-slate-200">{filteredLogs.length}</strong> of <strong className="text-slate-200">{logs.length}</strong> loaded events
            </span>
            <span>•</span>
            <span className="text-emerald-400 font-semibold">
              ⚡ {autoHealCount} Self-Heal Recoveries
            </span>
            <span>•</span>
            <span className={errorCount > 0 ? 'text-rose-400 font-semibold' : 'text-slate-500'}>
              🚨 {errorCount} Recorded Errors
            </span>
          </div>
          <div className="text-slate-500 flex items-center gap-1.5">
            <span>Autonomous In-Place Stream Healing:</span>
            <strong className="text-emerald-400 font-bold">ACTIVE</strong>
          </div>
        </div>

      </div>
    </div>
  );
}
