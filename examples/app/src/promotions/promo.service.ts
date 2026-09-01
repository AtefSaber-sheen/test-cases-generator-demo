// Miniature stand-in for a promotions service, used by examples/checkout.
// The business rules in the example's BusinessRules.md cite the lines below.

export class PromotionExpiredError extends Error {
  code = 'PROMO_EXPIRED';
}

export class PromotionAlreadyUsedError extends Error {
  code = 'PROMO_ALREADY_USED';
}

export class PromoService {
  constructor(private readonly repo: PromotionRepository, private readonly clock: Clock) {}

  /** BR-CHK-004 — discount is subtotal x percentage, rounded half-up to 2 decimals. */
  apply(subtotal: number, promotion: Promotion): number {
    const raw = subtotal * promotion.percentage;
    return Math.round(raw * 100) / 100;
  }

  /** BR-CHK-005 / BR-CHK-006 — the two rejections, deliberately separate. */
  async validate(code: string, customerId: string): Promise<Promotion> {
    const promotion = await this.repo.findByCode(code);
    if (!promotion) throw new Error('PROMO_NOT_FOUND');

    if (promotion.expiresAt.getTime() < this.clock.now().getTime()) {
      throw new PromotionExpiredError('Promotion has expired');
    }

    const alreadyUsed = await this.repo.hasRedeemed(promotion.id, customerId);
    if (alreadyUsed) {
      throw new PromotionAlreadyUsedError('Promotion already redeemed by this customer');
    }

    return promotion;
  }

  // Stacking is referenced by the UI but is not reachable from any surface in this example —
  // recorded as GAP-002 rather than guessed at.
  private stack(_promotions: Promotion[]): number {
    throw new Error('not implemented');
  }
}

export interface Promotion {
  id: string;
  code: string;
  percentage: number;
  expiresAt: Date;
}

export interface PromotionRepository {
  findByCode(code: string): Promise<Promotion | null>;
  hasRedeemed(promotionId: string, customerId: string): Promise<boolean>;
}

export interface Clock {
  now(): Date;
}
