import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@keiba/db';
@Injectable()
export class DbService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy() { await this.$disconnect(); }
}
