import {
  IsEmail,
  IsString,
  MinLength,
  MaxLength,
  IsOptional,
  Matches,
} from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(32)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message: 'Password must contain uppercase, lowercase and number',
  })
  password: string;

  @IsString()
  @MinLength(2)
  @MaxLength(64)
  name: string;

  @IsOptional()
  @IsString()
  @Matches(/^(0|\+84)(3[2-9]|5[25689]|7[06-9]|8[0-9]|9[0-9])\d{7}$/, {
    message: 'Số điện thoại không hợp lệ (VD: 0912345678)',
  })
  phone?: string;
}

export class LoginDto {
  @IsString()
  @MinLength(3)
  identifier: string;

  @IsString()
  @MinLength(1)
  password: string;
}

export class StaffLoginDto {
  @IsString()
  @MinLength(3)
  identifier: string;

  @IsString()
  @MinLength(1)
  password: string;
}

export class ResetPasswordRequestDto {
  @IsEmail()
  email: string;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(1)
  token: string;

  @IsString()
  @MinLength(8)
  @MaxLength(32)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message: 'Password must contain uppercase, lowercase and number',
  })
  newPassword: string;
}
