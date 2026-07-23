import type { PropsWithChildren } from "react";

export default function NarrationLayout({ children }: PropsWithChildren) {
  return <div className="contents" data-studio-layout="narration">{children}</div>;
}
