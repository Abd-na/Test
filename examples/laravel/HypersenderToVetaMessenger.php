<?php

/*
 * Move Veta from Hypersender to Veta Messenger WITHOUT changing the code that
 * calls Hypersender (the hypersender/hypersender-laravel SDK or plain Http:: calls).
 *
 * Paste the body of boot() into app/Providers/AppServiceProvider.php (Laravel 10.14+).
 * Every request Laravel's HTTP client sends to app.hypersender.com is redirected
 * to your Veta Messenger server, which speaks the same API.
 *
 * .env:
 *   VETA_MESSENGER_URL=https://msg.veta.example.com
 *   HYPERSENDER_WHATSAPP_API_KEY=vk_live_...      (the Veta Messenger API key)
 *   HYPERSENDER_SMS_API_KEY=vk_live_...
 *   HYPERSENDER_OTP_API_KEY=vk_live_...
 *   # instance ids can stay as they are (any value works; a Veta Messenger
 *   # WhatsApp instance id / SMS phone id pins that number / phone)
 *
 * config/services.php:
 *   'veta_messenger' => ['url' => env('VETA_MESSENGER_URL')],
 *
 * Then: php artisan config:clear
 */

namespace App\Providers;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\ServiceProvider;
use Psr\Http\Message\RequestInterface;

class AppServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        Http::globalRequestMiddleware(function (RequestInterface $request) {
            $target = config('services.veta_messenger.url');
            if (! $target || $request->getUri()->getHost() !== 'app.hypersender.com') {
                return $request;
            }
            $t = parse_url($target);
            $uri = $request->getUri()
                ->withScheme($t['scheme'] ?? 'https')
                ->withHost($t['host'])
                ->withPort($t['port'] ?? null);

            return $request->withUri($uri);
        });
    }
}
