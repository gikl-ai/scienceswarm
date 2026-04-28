"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function ProjectRouteCompatibilityRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const query = searchParams.toString();
    router.replace(`/dashboard/study${query ? `?${query}` : ""}`);
  }, [router, searchParams]);

  return null;
}

export default function ProjectPage() {
  return (
    <Suspense fallback={null}>
      <ProjectRouteCompatibilityRedirect />
    </Suspense>
  );
}
