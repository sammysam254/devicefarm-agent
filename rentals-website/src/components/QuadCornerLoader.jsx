import React from 'react';

export default function QuadCornerLoader({ text = 'Processing...', size = 'medium', inline = false }) {
  const isSmall = size === 'small';
  const boxSize = isSmall ? '24px' : '44px';

  return (
    <div style={{
      display: inline ? 'inline-flex' : 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: isSmall ? '6px' : '12px',
      padding: isSmall ? '0' : '8px'
    }}>
      <div style={{
        position: 'relative',
        width: boxSize,
        height: boxSize,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}>
        {/* Animated Connecting Outer Border */}
        <div className="quad-laser-border" />

        {/* 4 Corner Square Dots */}
        <span className="quad-dot top-left" />
        <span className="quad-dot top-right" />
        <span className="quad-dot bottom-right" />
        <span className="quad-dot bottom-left" />

        {/* Core Pulsing Center */}
        <div style={{
          width: isSmall ? '6px' : '10px',
          height: isSmall ? '6px' : '10px',
          borderRadius: '2px',
          background: 'linear-gradient(135deg, #0ea5e9, #a855f7)',
          boxShadow: '0 0 10px #0ea5e9',
          animation: 'quadCorePulse 1.2s ease-in-out infinite'
        }} />
      </div>

      {text && (
        <span style={{
          fontSize: isSmall ? '12px' : '13px',
          fontWeight: 700,
          color: 'var(--primary, #38bdf8)',
          letterSpacing: '0.4px',
          textTransform: 'uppercase'
        }}>
          {text}
        </span>
      )}
    </div>
  );
}
