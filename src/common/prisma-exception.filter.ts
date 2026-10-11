import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';

// Turns leaked database errors into proper HTTP responses instead of bare 500s
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Prisma');

  catch(e: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const known: Record<string, [number, string]> = {
      P2002: [409, 'A record with that value already exists'],
      P2025: [404, 'Record not found'],
      P2003: [409, 'This record is referenced by other data'],
      P2034: [409, 'Conflicting update, please retry'],
    };
    const [status, message] = known[e.code] ?? [500, 'Internal server error'];
    if (status === 500) this.logger.error(`${e.code}: ${e.message}`);
    res.status(status).json({ statusCode: status, message });
  }
}
