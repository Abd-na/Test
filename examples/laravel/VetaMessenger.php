<?php

namespace App\Services;

use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\RequestException;
use Illuminate\Support\Facades\Http;

/**
 * Client for the self-hosted Veta Messenger (WhatsApp + SMS gateway).
 *
 * .env:
 *   VETA_MESSENGER_URL=https://msg.veta.example.com
 *   VETA_MESSENGER_KEY=vk_live_...
 *   VETA_MESSENGER_WEBHOOK_SECRET=whsec_...
 *
 * config/services.php:
 *   'veta_messenger' => [
 *       'url' => env('VETA_MESSENGER_URL'),
 *       'key' => env('VETA_MESSENGER_KEY'),
 *       'webhook_secret' => env('VETA_MESSENGER_WEBHOOK_SECRET'),
 *   ],
 */
class VetaMessenger
{
    private function http(): PendingRequest
    {
        return Http::baseUrl(rtrim(config('services.veta_messenger.url'), '/') . '/api/v1')
            ->withToken(config('services.veta_messenger.key'))
            ->acceptJson()
            ->timeout(15);
    }

    private function post(string $path, array $payload): array
    {
        return $this->http()->post($path, $payload)->throw()->json('data');
    }

    /** Text message. $channel: auto (WhatsApp, falls back to SMS) | whatsapp | sms */
    public function send(string $to, string $text, string $channel = 'auto', array $options = []): array
    {
        return $this->post('/messages', array_merge(['to' => $to, 'text' => $text, 'channel' => $channel], $options));
    }

    public function whatsapp(string $to, string $text, array $options = []): array
    {
        return $this->send($to, $text, 'whatsapp', $options);
    }

    public function sms(string $to, string $text, array $options = []): array
    {
        return $this->send($to, $text, 'sms', $options);
    }

    /** $type: image | video | audio | document */
    public function media(string $to, string $type, string $url, ?string $caption = null, ?string $filename = null): array
    {
        return $this->post('/messages', array_filter([
            'to' => $to,
            'channel' => 'whatsapp',
            'type' => $type,
            'media_url' => $url,
            'text' => $caption,
            'filename' => $filename,
        ]));
    }

    /**
     * Sends a verification code. Returns ['id', 'expires_at', 'resend_after', ...].
     * Throws RequestException with status 429 when the user asks too often.
     */
    public function sendOtp(string $phone, string $purpose = 'login', string $channel = 'auto', ?string $ip = null): array
    {
        return $this->post('/otp/send', array_filter([
            'phone' => $phone,
            'purpose' => $purpose,
            'channel' => $channel,
            'ip' => $ip,
        ]));
    }

    /** true when the code is correct (a code can be used only once). */
    public function verifyOtp(string $phone, string $code, string $purpose = 'login'): bool
    {
        $result = $this->post('/otp/verify', ['phone' => $phone, 'code' => $code, 'purpose' => $purpose]);

        return (bool) ($result['valid'] ?? false);
    }

    public function message(string $id): array
    {
        return $this->http()->get("/messages/{$id}")->throw()->json('data');
    }

    public function isOnWhatsApp(string $phone): bool
    {
        $result = $this->post('/whatsapp/check', ['phone' => $phone]);

        return (bool) ($result[0]['exists'] ?? false);
    }

    /** Verifies the X-Veta-Signature header of an incoming webhook. */
    public static function validSignature(string $payload, ?string $timestamp, ?string $signature): bool
    {
        if (!$timestamp || !$signature || abs(time() - (int) $timestamp) > 300) {
            return false;
        }
        $expected = 'sha256=' . hash_hmac('sha256', $timestamp . '.' . $payload, config('services.veta_messenger.webhook_secret'));

        return hash_equals($expected, $signature);
    }
}
