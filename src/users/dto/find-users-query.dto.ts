import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** Customers imported from a marketplace: email `shopee_…` or a name masked by the source (`N******n`, `****`). */
export enum MaskedCustomerFilter {
  ALL = 'ALL',
  EXCLUDE = 'EXCLUDE',
  ONLY = 'ONLY',
}

export enum UserAccountTypeFilter {
  REGISTERED = 'REGISTERED',
  GUEST = 'GUEST',
}

export enum UserStatusFilter {
  ACTIVE = 'ACTIVE',
  BLOCKED = 'BLOCKED',
  DELETED = 'DELETED',
}

export enum UserOrdersFilter {
  /** At least one order, whatever its status. */
  HAS_ORDER = 'HAS_ORDER',
  /** At least one delivered order. */
  DELIVERED = 'DELIVERED',
  NONE = 'NONE',
}

export enum YesNoFilter {
  YES = 'YES',
  NO = 'NO',
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class FindUsersQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;

  /** Name, email or phone. */
  @IsOptional() @IsString() @MaxLength(200) search?: string;

  /** Absent = ALL: the list is also the customer picker of other screens. */
  @IsOptional() @IsEnum(MaskedCustomerFilter) masked?: MaskedCustomerFilter;
  @IsOptional() @IsEnum(UserAccountTypeFilter) accountType?: UserAccountTypeFilter;
  @IsOptional() @IsIn(['local', 'google', 'facebook']) provider?: string;

  /** Absent = every account that is not deleted. */
  @IsOptional() @IsEnum(UserStatusFilter) status?: UserStatusFilter;
  @IsOptional() @IsEnum(UserOrdersFilter) orders?: UserOrdersFilter;
  @IsOptional() @IsEnum(YesNoFilter) hasPhone?: YesNoFilter;
  @IsOptional() @IsEnum(YesNoFilter) marketingOptIn?: YesNoFilter;

  /** Creation day range (YYYY-MM-DD, Vietnam time, both ends included). */
  @IsOptional() @Matches(DAY) @IsDateString({ strict: true }) createdFrom?: string;
  @IsOptional() @Matches(DAY) @IsDateString({ strict: true }) createdTo?: string;
}
