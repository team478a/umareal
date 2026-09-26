import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { adminReferralListQuerySchema, adminReferralListResponseSchema, canManage, memberReferralRewardRedeemResponseSchema, memberReferralRewardsSchema, memberReferralSummarySchema, referralInvalidateSchema, referralRewardRedeemSchema } from '@keiba/domain';
import type { AppRequest } from './context';
import { AuthService } from './auth.service';
import { ReferralsService } from './referrals.service';

@Controller()
export class ReferralsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(ReferralsService) private readonly referrals: ReferralsService) {}

  private async member(req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    if (actor.role !== 'MEMBER') throw new ForbiddenException({ code: 'MEMBER_REQUIRED', message: '会員本人としてログインしてください。' });
    return actor;
  }

  private async admin(req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    if (!canManage(actor, ['ADMIN'])) throw new ForbiddenException({ code: actor.role === 'ADMIN' ? 'MFA_REQUIRED' : 'FORBIDDEN', message: '管理者権限と二段階認証を確認してください。' });
    return actor;
  }

  @Get('me/referrals')
  async mine(@Req() req: AppRequest) {
    const actor = await this.member(req);
    return memberReferralSummarySchema.parse(await this.referrals.memberSummary(actor.id));
  }

  @Get('me/referral-rewards')
  async rewards(@Req() req: AppRequest) {
    const actor = await this.member(req);
    const summary = await this.referrals.memberSummary(actor.id);
    return memberReferralRewardsSchema.parse({ items: summary.rewards });
  }

  @Post('me/referral-rewards/:id/redeem')
  async redeem(@Param('id') id: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.member(req);
    const input = referralRewardRedeemSchema.parse(body);
    return memberReferralRewardRedeemResponseSchema.parse(await this.referrals.redeem(actor.id, id, input.targetDate, req));
  }

  @Get('admin/referrals')
  async adminList(@Query() query: Record<string, unknown>, @Req() req: AppRequest) {
    await this.admin(req);
    const input = adminReferralListQuerySchema.parse(query);
    return adminReferralListResponseSchema.parse(await this.referrals.adminList(input.page, input.status));
  }

  @Get('admin/referrals/:id')
  async detail(@Param('id') id: string, @Req() req: AppRequest) { await this.admin(req); return this.referrals.adminDetail(id); }

  @Post('admin/referrals/:id/invalidate')
  async invalidate(@Param('id') id: string, @Body() body: unknown, @Req() req: AppRequest) {
    await this.admin(req); const input = referralInvalidateSchema.parse(body); return this.referrals.invalidate(id, input.reason, req);
  }
}
