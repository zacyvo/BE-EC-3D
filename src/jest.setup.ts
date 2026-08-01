// Ensures the `reflect-metadata` polyfill (needed by class-validator/class-transformer
// decorators) is loaded before any test file's decorators run, regardless of which
// spec file Jest happens to execute first in a given worker process.
import 'reflect-metadata';
