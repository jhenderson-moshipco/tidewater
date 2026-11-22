import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, type ReactNode } from 'react';

/** Renders under StrictMode, as main.tsx does, and returns a user-event session for it. */
export function renderWithUser(ui: ReactNode) {
  const user = userEvent.setup();
  return { user, ...render(<StrictMode>{ui}</StrictMode>) };
}
