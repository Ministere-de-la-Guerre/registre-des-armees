import { createContext, useContext } from "react";

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  danger?: boolean;
}

export type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

// Without a provider (isolated renders in tests) fall back to the native dialog.
// The app always mounts ConfirmProvider, so Electron never reaches this: a native
// confirm() there leaves text inputs unclickable until the window is refocused.
const fallbackConfirm: ConfirmFn = async (opts) => window.confirm(opts.message);

export const ConfirmContext = createContext<ConfirmFn>(fallbackConfirm);

/** In-app replacement for window.confirm(): `await confirm({ message })`. */
export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}
