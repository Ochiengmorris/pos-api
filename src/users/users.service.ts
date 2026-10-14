import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/decorators/current-user.decorator';
import { ChangePasswordDto } from './dto/change-password.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersDto } from './dto/list-users.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateUserDto } from './dto/update-user.dto';

// Never include passwordHash in responses
const publicSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateUserDto) {
    const email = dto.email.toLowerCase();
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw new ConflictException('Email already in use');

    return this.prisma.user.create({
      data: {
        email,
        name: dto.name.trim(),
        role: dto.role,
        passwordHash: await bcrypt.hash(dto.password, 12),
      },
      select: publicSelect,
    });
  }

  async findAll(query: ListUsersDto) {
    const where: Prisma.UserWhereInput = {
      ...(query.role && { role: query.role }),
      ...(query.search && {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { email: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: publicSelect,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      items,
      meta: {
        total,
        page: query.page,
        limit: query.limit,
        pages: Math.ceil(total / query.limit),
      },
    };
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: publicSelect,
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthUser) {
    await this.findOne(id);

    // Prevent an admin from locking themselves out
    if (id === actor.id) {
      if (dto.isActive === false) {
        throw new BadRequestException('You cannot deactivate your own account');
      }
      if (dto.role && dto.role !== Role.ADMIN) {
        throw new BadRequestException('You cannot change your own role');
      }
    }

    if (dto.email) {
      const email = dto.email.toLowerCase();
      const taken = await this.prisma.user.findFirst({
        where: { email, NOT: { id } },
      });
      if (taken) throw new ConflictException('Email already in use');
      dto.email = email;
    }

    return this.prisma.user.update({
      where: { id },
      data: { ...dto, ...(dto.name && { name: dto.name.trim() }) },
      select: publicSelect,
    });
  }

  async resetPassword(id: string, dto: ResetPasswordDto) {
    await this.findOne(id);
    await this.prisma.user.update({
      where: { id },
      data: { passwordHash: await bcrypt.hash(dto.newPassword, 12) },
    });
    return { message: 'Password reset' };
  }

  async changeOwnPassword(actor: AuthUser, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id: actor.id } });
    if (!user) throw new NotFoundException('User not found');

    const ok = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!ok) throw new BadRequestException('Current password is incorrect');

    await this.prisma.user.update({
      where: { id: actor.id },
      data: { passwordHash: await bcrypt.hash(dto.newPassword, 12) },
    });
    return { message: 'Password changed' };
  }
}
