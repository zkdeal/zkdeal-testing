import type { Hex } from 'viem'

/// The proof journal as the guest emits it (snake_case) mapped onto the
/// `RoomTypes.BatchJournal` tuple the L1 room manager accepts. The mapping is
/// exhaustive by construction: a missing field throws here rather than
/// encoding a zero word into a submitted batch.
export function value<T>(journal: Record<string, unknown>, name: string): T {
  const found = journal[name]
  if (found === undefined || found === null) throw new Error(`room journal is missing ${name}`)
  return found as T
}

export function contractJournal(raw: Record<string, unknown>) {
  return {
    protocolVersion: BigInt(value<number>(raw, 'protocol_version')),
    deploymentDomain: value<Hex>(raw, 'deployment_domain'),
    roomId: BigInt(value<number>(raw, 'room_id')),
    authorizationMode: value<number>(raw, 'authorization_mode'),
    coldTemplateId: value<Hex>(raw, 'cold_template_id'),
    proofProgramId: value<Hex>(raw, 'proof_program_id'),
    proofSystemVersion: value<Hex>(raw, 'proof_system_version'),
    policyHash: value<Hex>(raw, 'policy_hash'),
    batchIndex: BigInt(value<number>(raw, 'batch_index')),
    startL2Block: BigInt(value<number>(raw, 'start_l2_block')),
    endL2Block: BigInt(value<number>(raw, 'end_l2_block')),
    preStateRoot: value<Hex>(raw, 'pre_state_root'),
    postStateRoot: value<Hex>(raw, 'post_state_root'),
    batchDataHash: value<Hex>(raw, 'batch_data_hash'),
    canonicalDataHash: value<Hex>(raw, 'canonical_data_hash'),
    preParticipantRoot: value<Hex>(raw, 'pre_participant_root'),
    postParticipantRoot: value<Hex>(raw, 'post_participant_root'),
    preParticipantEpoch: BigInt(value<number>(raw, 'pre_participant_epoch')),
    postParticipantEpoch: BigInt(value<number>(raw, 'post_participant_epoch')),
    preParticipantCount: BigInt(value<number>(raw, 'pre_participant_count')),
    postParticipantCount: BigInt(value<number>(raw, 'post_participant_count')),
    participantCapacity: BigInt(value<number>(raw, 'participant_capacity')),
    preApproverRoot: value<Hex>(raw, 'pre_approver_root'),
    postApproverRoot: value<Hex>(raw, 'post_approver_root'),
    preApproverEpoch: BigInt(value<number>(raw, 'pre_approver_epoch')),
    postApproverEpoch: BigInt(value<number>(raw, 'post_approver_epoch')),
    preActiveCount: BigInt(value<number>(raw, 'pre_active_count')),
    postActiveCount: BigInt(value<number>(raw, 'post_active_count')),
    approverChangeCursorBefore: BigInt(value<number>(raw, 'approver_change_cursor_before')),
    approverChangeCursorAfter: BigInt(value<number>(raw, 'approver_change_cursor_after')),
    inboxCursorBefore: BigInt(value<number>(raw, 'inbox_cursor_before')),
    inboxCursorAfter: BigInt(value<number>(raw, 'inbox_cursor_after')),
    inboxRecordsHash: value<Hex>(raw, 'inbox_records_hash'),
    admissionCursorBefore: BigInt(value<number>(raw, 'admission_cursor_before')),
    admissionCursorAfter: BigInt(value<number>(raw, 'admission_cursor_after')),
    admissionRecordsHash: value<Hex>(raw, 'admission_records_hash'),
    forcedCursorBefore: BigInt(value<number>(raw, 'forced_cursor_before')),
    forcedCursorAfter: BigInt(value<number>(raw, 'forced_cursor_after')),
    forcedOutcomesHash: value<Hex>(raw, 'forced_outcomes_hash'),
    importCursorBefore: BigInt(value<number>(raw, 'import_cursor_before')),
    importCursorAfter: BigInt(value<number>(raw, 'import_cursor_after')),
    importedL1Block: BigInt(value<number>(raw, 'imported_l1_block')),
    importedL1HeaderHash: value<Hex>(raw, 'imported_l1_header_hash'),
    importedL1StateRoot: value<Hex>(raw, 'imported_l1_state_root'),
    importRoot: value<Hex>(raw, 'import_root'),
    outboxEpoch: BigInt(value<number>(raw, 'outbox_epoch')),
    withdrawalRoot: value<Hex>(raw, 'withdrawal_root'),
    preLiabilitiesHash: value<Hex>(raw, 'pre_liabilities_hash'),
    postLiabilitiesHash: value<Hex>(raw, 'post_liabilities_hash'),
    approverChangesHash: value<Hex>(raw, 'approver_changes_hash'),
    l1InclusionDeadline: BigInt(value<number>(raw, 'l1_inclusion_deadline')),
    close: value<boolean>(raw, 'close'),
  }
}

export type ContractJournal = ReturnType<typeof contractJournal>
