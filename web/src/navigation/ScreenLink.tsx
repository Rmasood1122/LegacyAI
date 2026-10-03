// A link to another screen that applies the screen's permission from the registry: a card that may
// not open the screen gets plain text, never a link that ends on "not available".
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useSession } from '../session/session.tsx';
import { mayOpen, routeOf, screenPath, type ScreenTarget } from './routes.ts';

/** Says whether the signed-in card may open a screen, and gives its address if so (null = it may not). */
export function useScreenPath(): (target: ScreenTarget) => string | null {
  const { can } = useSession();
  return (target) => {
    return mayOpen(routeOf(target.screen), can) ? screenPath(target) : null;
  };
}

export function ScreenLink({ children, ...target }: ScreenTarget & { children: ReactNode }) {
  const path = useScreenPath()(target);
  return path === null ? <span>{children}</span> : <Link to={path}>{children}</Link>;
}
