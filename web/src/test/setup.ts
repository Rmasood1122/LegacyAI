// Runs before every test file: unmount what the previous test rendered.
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());
