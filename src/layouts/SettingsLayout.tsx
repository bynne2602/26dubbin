import type { PropsWithChildren } from "react";

export default function SettingsLayout({ children }: PropsWithChildren) {
  return <div className="contents" data-studio-layout="settings">{children}</div>;
}
