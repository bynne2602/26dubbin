import type { PropsWithChildren } from "react";

export default function AutoDubbingLayout({ children }: PropsWithChildren) {
  return <div className="contents" data-studio-layout="auto-dubbing">{children}</div>;
}
