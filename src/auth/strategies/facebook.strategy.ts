import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-facebook';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class FacebookStrategy extends PassportStrategy(Strategy, 'facebook') {
  constructor(configService: ConfigService) {
    super({
      clientID: configService.get<string>('FACEBOOK_APP_ID') || '',
      clientSecret: configService.get<string>('FACEBOOK_APP_SECRET') || '',
      callbackURL: configService.get<string>('FACEBOOK_CALLBACK_URL') || '',
      scope: ['email'],
      profileFields: ['emails', 'name', 'picture'],
    });
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: (err: Error | null, user: unknown) => void,
  ): void {
    const { emails, name, photos } = profile;
    const user = {
      email: emails?.[0]?.value,
      name: `${name?.givenName} ${name?.familyName}`.trim(),
      avatar: photos?.[0]?.value,
      provider: 'facebook',
      providerId: profile.id,
    };
    done(null, user);
  }
}
