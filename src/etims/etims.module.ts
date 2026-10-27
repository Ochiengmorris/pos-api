import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { EtimsConfig } from './etims.config';
import { EtimsController } from './etims.controller';
import { EtimsService } from './etims.service';
import { EtimsWorker } from './etims.worker';
import { ETIMS_PROVIDER } from './etims.types';
import { MockEtimsProvider } from './providers/mock.provider';
import { EtimsAlerts } from './etims.alert';

@Module({
  imports: [SettingsModule],
  controllers: [EtimsController],
  providers: [
    EtimsConfig,
    MockEtimsProvider,
    EtimsService,
    EtimsWorker,
    EtimsAlerts,
    {
      provide: ETIMS_PROVIDER,
      inject: [EtimsConfig, MockEtimsProvider],
      useFactory: (cfg: EtimsConfig, mock: MockEtimsProvider) => {
        if (cfg.provider === 'oscu') {
          // refuse to start rather than quietly pretend: the live provider arrives in phase E4
          throw new Error(
            'ETIMS_PROVIDER=oscu is not available yet. Use "mock" for development.',
          );
        }
        return mock;
      },
    },
  ],
  exports: [EtimsService, EtimsConfig],
})
export class EtimsModule {}
