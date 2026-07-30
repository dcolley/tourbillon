export type ActionResult =
  | { ok: true; message: string; redirectTo?: string }
  | { ok: false; error: string };

export function actionSuccess(message: string, redirectTo?: string): ActionResult {
  return redirectTo ? { ok: true, message, redirectTo } : { ok: true, message };
}

export function actionError(error: string): ActionResult {
  return { ok: false, error };
}
