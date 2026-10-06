/**
 * Shared data-state renderer: loading / error / empty / content.
 * Guarantees every page handles all four states.
 */
import type { ReactNode } from "react";
import { ApiError, friendlyMessage } from "../api/client.js";
import { EmptyState, ErrorState, LoadingState } from "../components/chrome.js";

export function DataState<T>({
  loading,
  error,
  data,
  empty,
  onRetry,
  children,
}: {
  loading: boolean;
  error: ApiError | null;
  data: T | null;
  empty: { title: string; body: string; action?: ReactNode };
  onRetry: () => void;
  children: (data: T) => ReactNode;
}) {
  if (loading) {
    return <LoadingState />;
  }
  if (error) {
    return (
      <ErrorState
        message={friendlyMessage(error)}
        requestId={error.requestId}
        onRetry={onRetry}
      />
    );
  }
  if (data === null || (Array.isArray(data) && data.length === 0)) {
    return (
      <EmptyState title={empty.title} body={empty.body} action={empty.action} />
    );
  }
  return <>{children(data)}</>;
}
