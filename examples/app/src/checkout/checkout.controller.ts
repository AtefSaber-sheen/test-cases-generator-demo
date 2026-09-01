// Miniature stand-in for a checkout controller, used by examples/checkout.
// Two surfaces live here: POST /api/checkout and GET /api/checkout/:id.

import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';

import { CheckoutRequest } from './dto/checkout.dto';
import { PromoService } from '../promotions/promo.service';

@Controller('api/checkout')
@UseGuards(JwtAuthGuard)
export class CheckoutController {
  constructor(
    private readonly promos: PromoService,
    private readonly orders: OrderService
  ) {}

  /** SF-API-011 — submit a cart and create an order. */
  @Post()
  @Roles('customer')
  async submit(@Body() body: CheckoutRequest, @Req() req: AuthedRequest) {
    const cart = await this.orders.loadCart(body.cartId, req.user.id);
    if (!cart) throw new NotFoundException('CART_NOT_FOUND');
    if (cart.items.length === 0) throw new UnprocessableEntityException('CART_EMPTY');

    let discount = 0;
    if (body.promoCode) {
      const promotion = await this.promos.validate(body.promoCode, req.user.id);
      discount = this.promos.apply(cart.subtotal, promotion);
    }

    return this.orders.create({
      cartId: cart.id,
      customerId: req.user.id,
      discount,
      total: cart.subtotal - discount,
    });
  }

  /** SF-API-012 — read one order. Ownership is enforced here, not by the role guard. */
  @Get(':id')
  @Roles('customer', 'support')
  async read(@Param('id') id: string, @Req() req: AuthedRequest) {
    const order = await this.orders.findById(id);
    if (!order) throw new NotFoundException('ORDER_NOT_FOUND');
    if (order.customerId !== req.user.id && req.user.role !== 'support') {
      // Deliberately 404, not 403: the example's expected results must match this, not convention.
      throw new NotFoundException('ORDER_NOT_FOUND');
    }
    return order;
  }
}
