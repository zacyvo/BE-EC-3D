import { FilterQuery } from 'mongoose';
import { UserDocument } from './schemas/user.schema';
import {
  FindUsersQueryDto, MaskedCustomerFilter, UserAccountTypeFilter, UserStatusFilter, YesNoFilter,
} from './dto/find-users-query.dto';

const SHOPEE_EMAIL = /^shopee_/i;
/** Two asterisks in a row never occur in a real name; Shopee masks as `****` or `N******n`. */
const MASKED_NAME = /\*{2,}/;

const DAY_MS = 24 * 60 * 60 * 1000;
const startOfVnDay = (day: string) => new Date(`${day}T00:00:00+07:00`);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function searchCondition(search: string): FilterQuery<UserDocument> {
  const text = { $regex: escapeRegex(search), $options: 'i' };
  const or: FilterQuery<UserDocument>[] = [{ name: text }, { email: text }];
  // Phones are stored as 0xxxxxxxxx — accept "+84 912 345 678", "0912.345.678"…
  const compact = search.replace(/[\s.-]/g, '');
  if (/^\+?\d{3,}$/.test(compact)) {
    or.push({ phone: { $regex: escapeRegex(compact.replace(/^\+84/, '0')) } });
  }
  return { $or: or };
}

/** Everything of the admin customer list filter that lives on the user itself (`orders` is resolved by the service). */
export function buildUsersFilter(query: Partial<FindUsersQueryDto>): FilterQuery<UserDocument> {
  const and: FilterQuery<UserDocument>[] = [];

  const search = query.search?.trim();
  if (search) and.push(searchCondition(search));

  if (query.masked === MaskedCustomerFilter.EXCLUDE) {
    and.push({ email: { $not: SHOPEE_EMAIL } }, { name: { $not: MASKED_NAME } });
  } else if (query.masked === MaskedCustomerFilter.ONLY) {
    and.push({ $or: [{ email: SHOPEE_EMAIL }, { name: MASKED_NAME }] });
  }

  if (query.accountType) {
    and.push({ isGuest: query.accountType === UserAccountTypeFilter.GUEST ? true : { $ne: true } });
  }
  if (query.provider) and.push({ provider: query.provider });

  if (query.status === UserStatusFilter.ACTIVE) and.push({ isBlocked: { $ne: true } });
  if (query.status === UserStatusFilter.BLOCKED) and.push({ isBlocked: true });

  if (query.hasPhone) {
    and.push({ phone: query.hasPhone === YesNoFilter.YES ? { $nin: [null, ''] } : { $in: [null, ''] } });
  }
  if (query.marketingOptIn) {
    and.push({ marketingOptIn: query.marketingOptIn === YesNoFilter.YES ? true : { $ne: true } });
  }

  if (query.createdFrom) and.push({ createdAt: { $gte: startOfVnDay(query.createdFrom) } });
  if (query.createdTo) {
    and.push({ createdAt: { $lt: new Date(startOfVnDay(query.createdTo).getTime() + DAY_MS) } });
  }

  // Always explicit and top-level: the schema's find hook adds isDeleted:false when it isn't, and
  // that hook doesn't run for countDocuments.
  return {
    isDeleted: query.status === UserStatusFilter.DELETED,
    ...(and.length ? { $and: and } : {}),
  };
}
