/**
 * Two-gate model (product lock): BOTH flags must be true for any Computer access.
 * The `company-computer` toolset alone NEVER bypasses these gates — assembly may
 * attach the tools, but every call re-checks company `hasComputer` AND agent
 * `hasComputer` here (server side, in the API route) before doing anything.
 */
import { GATE_AGENT_NO_COMPUTER, GATE_COMPANY_NOT_PROVISIONED } from './constants';
import { GateError } from './types';
import type { ComputerContext } from './types';

/** Throws GateError with the locked wording when either gate is closed. Order: company first. */
export function assertComputerGates(ctx: Pick<ComputerContext, 'companyHasComputer' | 'agentHasComputer'>): void {
  if (ctx.companyHasComputer !== true) {
    throw new GateError('company_not_provisioned', GATE_COMPANY_NOT_PROVISIONED);
  }
  if (ctx.agentHasComputer !== true) {
    throw new GateError('agent_no_computer', GATE_AGENT_NO_COMPUTER);
  }
}

export function computerGatesOpen(ctx: Pick<ComputerContext, 'companyHasComputer' | 'agentHasComputer'>): boolean {
  return ctx.companyHasComputer === true && ctx.agentHasComputer === true;
}
