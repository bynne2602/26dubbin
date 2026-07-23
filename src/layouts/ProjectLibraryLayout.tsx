import type { PropsWithChildren } from "react";

export default function ProjectLibraryLayout({ children }: PropsWithChildren) {
  return <div className="contents" data-studio-layout="project-library">{children}</div>;
}
