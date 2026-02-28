import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';

class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;
}

class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  name: string;
}

@ApiTags('Auth')
@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  async login(@Body() dto: LoginDto) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isValid = await this.authService.comparePassword(
      dto.password,
      user.passwordHash,
    );
    if (!isValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const token = this.authService.generateToken({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    return {
      accessToken: token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  @Post('register')
  @ApiOperation({ summary: 'Register a new user account' })
  async register(@Body() dto: RegisterDto) {
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    // First user becomes ADMIN
    const userCount = await this.usersService.count();
    const role = userCount === 0 ? 'ADMIN' : 'EDITOR';

    const passwordHash = await this.authService.hashPassword(dto.password);
    const user = await this.usersService.create({
      email: dto.email,
      passwordHash,
      name: dto.name,
      role: role as any,
    });

    const token = this.authService.generateToken({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    return {
      accessToken: token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }
}
