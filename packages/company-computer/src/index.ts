/**
 * @tourbillon/company-computer — Slice 1 (app code only).
 *
 * Per-agent KasmVNC desktop seats (`kasmweb/desktop` containers), canonical /opt
 * mounts, two-gate enforcement, session registry, and the agent-facing toolset.
 * Nothing here talks to Docker directly; host operations go through an injected
 * HostClient and Slice 1 ships only the dry-run implementation (CC_ALLOW_START=1 +
 * Ops scripts gate any real start — Ops contract, Slice 2).
 */
export * from './constants';
export * from './types';
export * from './ensure-company-dirs';
export * from './ops-inventory';
export * from './gates';
export * from './session-registry';
export * from './host-client';
export * from './lifecycle';
export * from './settings';
export { COMPANY_COMPUTER_TOOLS } from './tools';
