import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

const initialWidth = window.innerWidth;
const initialHeight = window.innerHeight;
const initialMatchMedia = window.matchMedia;

afterEach(() => {
  cleanup();
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: initialWidth });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: initialHeight });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: initialMatchMedia,
  });
  window.dispatchEvent(new Event('resize'));
});
