import type { PropsWithChildren } from "react";

export default function TranslationLayout({ children }: PropsWithChildren) {
  return <div className="contents" data-studio-layout="translation">{children}</div>;
}
