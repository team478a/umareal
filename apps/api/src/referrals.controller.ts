import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { adminReferralBenefitCreateSchema, adminReferralBenefitGrantListQuerySchema, adminReferralBenefitGrantsResponseSchema, adminReferralBenefitMutationResponseSchema, adminReferralBenefitsResponseSchema, adminReferralBenefitVersionCreateSchema, adminReferralDetailResponseSchema, adminReferralInvalidateResponseSchema, adminReferralListQuerySchema, adminReferralListResponseSchema, canManage, memberReferralBenefitGrantsResponseSchema, memberReferralBenefitProgramResponseSchema, memberReferralRewardRedeemResponseSchema, memberReferralRewardsSchema, memberReferralSummarySchema, referralBenefitGrantRedeemResponseSchema, referralBenefitGrantRedeemSchema, referralInvalidateSchema, referralRewardRedeemSchema } from '@keiba/domain';
import { z } from 'zod';
import type { AppRequest } from './context';
import { AuthService } from './auth.service';
import { ReferralsService } from './referrals.service';
import { ReferralBenefitsService } from './referral-benefits.service';

@Controller()
export class ReferralsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ReferralsService) private readonly referrals: ReferralsService,
    @Inject(ReferralBenefitsService) private readonly benefits: ReferralBenefitsService
  ) {}

  private requestKey(req: AppRequest) {
    return z.string().uuid().parse(req.header('idempotency-key'));
  }

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

  @Get('me/referral-benefit-grants')
  async benefitGrants(@Req() req: AppRequest) {
    const actor = await this.member(req);
    return memberReferralBenefitGrantsResponseSchema.parse(await this.benefits.memberGrants(actor.id));
  }

  @Get('me/referral-benefit-program')
  async benefitProgram(@Req() req: AppRequest) {
    const actor = await this.member(req);
    return memberReferralBenefitProgramResponseSchema.parse(await this.benefits.memberProgram(actor.id));
  }

  @Post('me/referral-benefit-grants/:id/redeem')
  async redeemBenefit(@Param('id') id: string, @Body() body: unknown, @Req() req: AppRequest) {
    z.string().uuid().parse(id);
    const actor = await this.member(req);
    const input = referralBenefitGrantRedeemSchema.parse(body);
    return referralBenefitGrantRedeemResponseSchema.parse(await this.benefits.redeem(actor.id, id, input.targetDate, this.requestKey(req), req));
  }

  @Get('admin/referrals/benefits')
  async benefitsList(@Req() req: AppRequest) {
    await this.admin(req);
    return adminReferralBenefitsResponseSchema.parse(await this.benefits.adminList());
  }

  @Post('admin/referrals/benefits')
  async createBenefit(@Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.admin(req);
    const input = adminReferralBenefitCreateSchema.parse(body);
    return adminReferralBenefitMutationResponseSchema.parse(await this.benefits.create(actor.id, input, this.requestKey(req), req));
  }

  @Post('admin/referrals/benefits/:id/versions')
  async createBenefitVersion(@Param('id') id: string, @Body() body: unknown, @Req() req: AppRequest) {
    z.string().uuid().parse(id);
    const actor = await this.admin(req);
    const input = adminReferralBenefitVersionCreateSchema.parse(body);
    return adminReferralBenefitMutationResponseSchema.parse(await this.benefits.createVersion(id, actor.id, input, this.requestKey(req), req));
  }

  @Get('admin/referrals/benefit-grants')
  async benefitGrantList(@Query() query: Record<string, unknown>, @Req() req: AppRequest) {
    await this.admin(req);
    const input = adminReferralBenefitGrantListQuerySchema.parse(query);
    return adminReferralBenefitGrantsResponseSchema.parse(await this.benefits.adminGrants(input.page, input.status));
  }

  @Get('admin/referrals')
  async adminList(@Query() query: Record<string, unknown>, @Req() req: AppRequest) {
    await this.admin(req);
    const input = adminReferralListQuerySchema.parse(query);
    return adminReferralListResponseSchema.parse(await this.referrals.adminList(input.page, input.status));
  }

  @Get('admin/referrals/:id')
  async detail(@Param('id') id: string, @Req() req: AppRequest) {
    await this.admin(req);
    return adminReferralDetailResponseSchema.parse(await this.referrals.adminDetail(id));
  }

  @Post('admin/referrals/:id/invalidate')
  async invalidate(@Param('id') id: string, @Body() body: unknown, @Req() req: AppRequest) {
    await this.admin(req);
    const input = referralInvalidateSchema.parse(body);
    return adminReferralInvalidateResponseSchema.parse(await this.referrals.invalidate(id, input.reason, req));
  }
}
