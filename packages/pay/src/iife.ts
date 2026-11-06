// <script src="tazor-pay.js">: registers <tazor-pay-button> and exposes window.TazorPay.
import * as TazorPay from './index.ts';

TazorPay.defineTazorPayButton();
(globalThis as { TazorPay?: typeof TazorPay }).TazorPay = TazorPay;
