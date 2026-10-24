/**
 * WID-1: the assistant's widget specs (no components), shared by the AG-UI route (server) and the
 * client registry. The route only offers a widget tool to a run when the client declares it in
 * `RunAgentInput.tools` and it is listed here, and it validates answers against these schemas, never
 * against schemas sent by the client.
 *
 * Empty until WID-2 / WID-3 add widgets; add the spec here and the `{ ...spec, component }`
 * definition to `assistantWidgetRegistry` together.
 */
import { createWidgetSpecIndex, type WidgetSpec } from '@tourbillon/shared/widgets';

export const assistantWidgetSpecs: readonly WidgetSpec[] = [];

export const assistantWidgetSpecIndex = createWidgetSpecIndex(assistantWidgetSpecs);
