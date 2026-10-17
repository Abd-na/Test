<?php

namespace App\Http\Controllers;

use App\Services\VetaMessenger;
use Illuminate\Http\Client\RequestException;
use Illuminate\Http\Request;

/** Example: phone login with a one-time code. */
class OtpExampleController extends Controller
{
    public function __construct(private VetaMessenger $messenger)
    {
    }

    public function send(Request $request)
    {
        $data = $request->validate(['phone' => 'required|string|max:20']);

        try {
            $otp = $this->messenger->sendOtp($data['phone'], 'login', 'auto', $request->ip());
        } catch (RequestException $e) {
            if ($e->response->status() === 429) {
                return response()->json([
                    'message' => 'انتظر قليلاً قبل طلب رمز جديد',
                    'retry_after' => $e->response->json('error.details.retry_after'),
                ], 429);
            }
            throw $e;
        }

        return response()->json(['sent' => true, 'expires_at' => $otp['expires_at'], 'resend_after' => $otp['resend_after']]);
    }

    public function verify(Request $request)
    {
        $data = $request->validate(['phone' => 'required|string', 'code' => 'required|string|max:10']);

        if (!$this->messenger->verifyOtp($data['phone'], $data['code'], 'login')) {
            return response()->json(['message' => 'الرمز غير صحيح أو منتهي'], 422);
        }

        // code is valid: find or create the user and log them in
        return response()->json(['verified' => true]);
    }
}
