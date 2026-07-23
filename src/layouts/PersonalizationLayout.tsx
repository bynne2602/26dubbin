import type { PropsWithChildren } from "react";

export default function PersonalizationLayout({ children }: PropsWithChildren) {
  return <div className="contents" data-studio-layout="personalization">{children}</div>;
}
