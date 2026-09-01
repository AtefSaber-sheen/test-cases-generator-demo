// Miniature stand-in for a real DTO, used by examples/checkout.
// The line numbers here are what the example's Source Evidence columns cite, so keep the file
// stable: moving a decorator changes what the evidence points at.

import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

export class CheckoutRequest {
  @IsString()
  cartId!: string;

  @IsInt()
  @Min(1)
  @Max(99)
  quantity: number = 1;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9]{4,12}$/)
  promoCode?: string;
}
