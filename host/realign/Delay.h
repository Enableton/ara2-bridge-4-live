#pragma once

// Internal helper of Realign.cpp, in a header so the tests can measure it directly.

#include <cmath>
#include <cstdint>
#include <vector>

namespace bridge
{
    namespace detail
    {
        const double kPi { 3.14159265358979323846 };

        // x[index], or 0 outside the vector.
        inline float sampleAt (const std::vector<float>& x, int64_t index)
        {
            return index >= 0 && index < static_cast<int64_t> (x.size ()) ? x[static_cast<size_t> (index)] : 0.0f;
        }

        // Moves audio LATER by 'shift' samples: out[i] = x[i - shift]. Whole-sample shifts are exact copies;
        // fractional ones use a Hann-windowed sinc with 32 taps whose weights are computed once.
        // Samples outside the vector count as 0, so the first and last ~16 samples of a clip ring when a
        // fractional shift is applied to them. Non-finite input samples spread over 32 outputs; callers
        // that cannot rule them out should sanitise the source first (realign() does).
        class Delay
        {
        public:
            explicit Delay (double shift)
            {
                const double position { -shift };                             // out[i] = x(i + position)
                _whole = static_cast<int64_t> (std::floor (position));
                const double fraction { position - static_cast<double> (_whole) };
                _exact = fraction < 1e-9;
                if (_exact)
                    return;

                double sum { 0.0 };
                for (int k { 0 }; k < kTaps; ++k)
                {
                    const double t { static_cast<double> (k - kHalf + 1) - fraction };    // distance of tap k from the wanted point
                    const double x { kPi * t };
                    const double sinc { std::fabs (x) < 1e-12 ? 1.0 : std::sin (x) / x };
                    const double window { 0.5 * (1.0 + std::cos (kPi * t / kHalf)) };
                    _weights[k] = sinc * window;
                    sum += _weights[k];
                }
                for (double& weight : _weights)
                    weight /= sum;
            }

            float at (const std::vector<float>& x, int64_t i) const
            {
                if (_exact)
                    return sampleAt (x, i + _whole);
                double acc { 0.0 };
                for (int k { 0 }; k < kTaps; ++k)
                    acc += _weights[k] * static_cast<double> (sampleAt (x, i + _whole + (k - kHalf + 1)));
                return static_cast<float> (acc);
            }

        private:
            static constexpr int kHalf { 16 };
            static constexpr int kTaps { 2 * kHalf };
            int64_t _whole { 0 };
            bool _exact { true };
            double _weights[kTaps] {};
        };
    }
}
