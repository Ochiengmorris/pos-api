import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthUser } from '../auth/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateStoreDto } from './dto/update-store.dto';

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // The row is created on first use from the old .env values, so upgrading changes nothing visible
  get() {
    return this.prisma.storeSettings.upsert({
      where: { id: 'store' },
      update: {},
      create: {
        id: 'store',
        name: this.config.get<string>('STORE_NAME', 'My Shop'),
        address: this.config.get<string>('STORE_ADDRESS', ''),
        phone: this.config.get<string>('STORE_PHONE', ''),
        taxPin: this.config.get<string>('STORE_TAX_PIN', ''),
      },
    });
  }

  async update(dto: UpdateStoreDto, actor: AuthUser) {
    await this.get(); // make sure the row exists
    const trim = (v?: string) => (v === undefined ? undefined : v.trim());
    return this.prisma.storeSettings.update({
      where: { id: 'store' },
      data: {
        name: trim(dto.name),
        address: trim(dto.address),
        phone: trim(dto.phone),
        taxPin: trim(dto.taxPin),
        receiptFooter: trim(dto.receiptFooter),
        updatedById: actor.id,
      },
    });
  }
}
