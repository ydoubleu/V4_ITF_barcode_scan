import React from 'react';
import { FeedbackState } from '../types';

interface FeedbackOverlayProps {
  state: FeedbackState;
}

export const FeedbackOverlay: React.FC<FeedbackOverlayProps> = ({ state }) => {
  if (!state) return null;

  const { type, message } = state;

  const colorClass = type === 'success' ? 'bg-green-500/20' : 'bg-red-500/20';
  const borderClass = type === 'success' ? 'border-green-300' : 'border-red-300';
  const textClass = type === 'success' ? 'text-green-50' : 'text-red-50';

  return (
    <div className={`absolute inset-0 z-50 pointer-events-none flex flex-col items-center justify-center animate-pulse transition-colors duration-200 ${colorClass}`}>
      <div className={`border-4 ${borderClass} rounded-2xl px-8 py-6 bg-black/40 backdrop-blur-sm shadow-xl max-w-[90%]`}>
        <h2 className={`text-3xl md:text-4xl font-extrabold ${textClass} drop-shadow-lg text-center whitespace-pre-line leading-tight`}>
          {message}
        </h2>
      </div>
    </div>
  );
};