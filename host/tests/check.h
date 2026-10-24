#pragma once

#include <cmath>
#include <cstdio>
#include <functional>
#include <utility>
#include <vector>

struct TestCase
{
    const char* name;
    std::function<void ()> run;
};

std::vector<TestCase>& allTests ();
extern int gFailures;

struct TestRegistrar
{
    TestRegistrar (const char* name, std::function<void ()> run) { allTests ().push_back ({ name, std::move (run) }); }
};

#define TEST(name)                                          \
    static void name ();                                    \
    static TestRegistrar registrar_##name (#name, name);    \
    static void name ()

#define CHECK(cond)                                                                              \
    do                                                                                           \
    {                                                                                            \
        if (! (cond))                                                                            \
        {                                                                                        \
            std::printf ("    CHECK failed %s:%d: %s\n", __FILE__, __LINE__, #cond);             \
            ++gFailures;                                                                         \
        }                                                                                        \
    } while (0)

// Like CHECK, but also ends the current test: use it before indexing into data the check guards.
#define REQUIRE(cond)                                                                            \
    do                                                                                           \
    {                                                                                            \
        if (! (cond))                                                                            \
        {                                                                                        \
            std::printf ("    REQUIRE failed %s:%d: %s\n", __FILE__, __LINE__, #cond);           \
            ++gFailures;                                                                         \
            return;                                                                              \
        }                                                                                        \
    } while (0)

#define CHECK_NEAR(a, b, eps)                                                                    \
    do                                                                                           \
    {                                                                                            \
        const double va_ = (a), vb_ = (b);                                                       \
        if (! (std::fabs (va_ - vb_) <= (eps)))                                                  \
        {                                                                                        \
            std::printf ("    CHECK_NEAR failed %s:%d: %s=%g vs %s=%g\n", __FILE__, __LINE__, #a, va_, #b, vb_); \
            ++gFailures;                                                                         \
        }                                                                                        \
    } while (0)
