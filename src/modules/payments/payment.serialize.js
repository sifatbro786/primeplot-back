/** Client-safe view of an online payment (portal) — no gateway internals. */
export function toOnlinePayment(p) {
  return {
    id: String(p._id),
    tranId: p.tranId,
    bookingId: String(p.bookingId),
    bookingNo: p.bookingNo,
    unitCode: p.unitCode,
    amount: p.amount,
    currency: p.currency,
    // A held payment reads as "being checked" to the client; staff see the reason.
    status: p.status,
    receipt: p.receiptId ? { id: String(p.receiptId), receiptNo: p.receiptNo } : null,
    method: p.gateway?.cardType ?? null,
    paidAt: p.paidAt ?? null,
    createdAt: p.createdAt,
  };
}

/** Staff view: everything, including the gateway trail. */
export function toStaffOnlinePayment(p) {
  return {
    ...toOnlinePayment(p),
    customerId: String(p.customerId),
    customerName: p.customerName,
    projectId: String(p.projectId),
    reviewReason: p.reviewReason ?? null,
    gateway: {
      valId: p.gateway?.valId ?? null,
      bankTranId: p.gateway?.bankTranId ?? null,
      cardType: p.gateway?.cardType ?? null,
      cardBrand: p.gateway?.cardBrand ?? null,
      cardIssuer: p.gateway?.cardIssuer ?? null,
      riskLevel: p.gateway?.riskLevel ?? null,
      riskTitle: p.gateway?.riskTitle ?? null,
      tranDate: p.gateway?.tranDate ?? null,
      validatedAmount: p.gateway?.validatedAmount ?? null,
      validationStatus: p.gateway?.validationStatus ?? null,
      validatedAt: p.gateway?.validatedAt ?? null,
    },
    review: p.review
      ? {
          at: p.review.at,
          by: p.review.by ? { id: String(p.review.by), name: p.review.byName ?? null } : null,
          decision: p.review.decision,
          note: p.review.note ?? null,
        }
      : null,
    events: (p.events ?? []).map((e) => ({
      at: e.at,
      source: e.source,
      status: e.status ?? null,
      note: e.note ?? null,
    })),
    lastCheckedAt: p.lastCheckedAt ?? null,
  };
}
